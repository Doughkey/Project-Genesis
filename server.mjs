import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import { FixedWindowRateLimiter } from "./lib/rate-limit.js";
import { exportWeeklyReport, getNewsItems, getWeeklyReports, ingestFeeds, readLimitedBody, startScheduler } from "./js/ingestion-worker.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const archivePath = resolve(root, "data", "archive.json");
const categories = new Set(["maritime", "security", "public", "humanitarian"]);
const theatres = new Set(["luzon", "visayas", "mindanao", "west-philippine-sea", "pacific"]);
const perspectives = new Set(["left", "center", "right", "unrated"]);
const confidenceLevels = new Set(["confirmed", "reported", "unverified"]);
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/js/data-source.js", "js/data-source.js"]
]);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const pollHours = Number(process.env.INGEST_INTERVAL_HOURS || 3);
const pagasaFeedUrl = "https://publicalert.pagasa.dost.gov.ph/feeds/";
const pagasaParser = new Parser({ maxRedirects: 0 });
const advisoryCacheMs = 10 * 60 * 1000;
const maximumAdvisoryFeedBytes = 1024 * 1024;
let cachedAdvisories = { fetchedAt: 0, data: [] };
const trustProxy = process.env.TRUST_PROXY === "true";
const rateWindowMs = 60 * 1000;
const publicRateLimit = new FixedWindowRateLimiter({ limit: Number(process.env.PUBLIC_API_RATE_LIMIT || 120), windowMs: rateWindowMs });
const adminRateLimit = new FixedWindowRateLimiter({ limit: Number(process.env.ADMIN_API_RATE_LIMIT || 20), windowMs: rateWindowMs });

if (process.env.NODE_ENV === "production" && (process.env.MATANGLAWIN_ADMIN_TOKEN || "").length < 32) {
  throw new Error("MATANGLAWIN_ADMIN_TOKEN must be set to at least 32 characters in production");
}

function getClientAddress(request) {
  if (trustProxy) {
    const forwardedFor = request.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.trim()) return forwardedFor.split(",")[0].trim().slice(0, 100);
  }
  return request.socket.remoteAddress || "unknown";
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function applyApiRateLimit(request, response, url) {
  const isAdmin = url.pathname.startsWith("/api/v1/admin/");
  const limiter = isAdmin ? adminRateLimit : publicRateLimit;
  const result = limiter.consume(`${getClientAddress(request)}:${url.pathname}`);
  applySecurityHeaders(response);
  response.setHeader("RateLimit-Limit", String(result.limit));
  response.setHeader("RateLimit-Remaining", String(result.remaining));
  response.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
  if (result.allowed) return true;
  response.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify({ error: "Too many requests; retry after the rate-limit window" }));
  return false;
}

function isAdminRequest(request) {
  const expected = process.env.MATANGLAWIN_ADMIN_TOKEN || "";
  const authorization = request.headers.authorization || "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length > 0 && expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer);
}

async function getPublicAdvisories() {
  if (Date.now() - cachedAdvisories.fetchedAt < advisoryCacheMs) {
    return { ...cachedAdvisories, cached: true };
  }

  const response = await fetch(pagasaFeedUrl, {
    headers: { Accept: "application/atom+xml, application/xml, text/xml" },
    redirect: "error",
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("PAGASA advisory feed unavailable");
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!new Set(["application/atom+xml", "application/xml", "text/xml"]).has(contentType)) {
    throw new Error("Unexpected PAGASA feed content type");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumAdvisoryFeedBytes) {
    throw new Error("PAGASA feed exceeds size limit");
  }
  const body = await readLimitedBody(response);
  const feed = await pagasaParser.parseString(body);
  const data = (Array.isArray(feed.items) ? feed.items : []).slice(0, 80).flatMap((item) => {
    const title = typeof item.title === "string" ? item.title.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) : "";
    const updatedAt = item.isoDate || item.pubDate || "";
    let link;
    try {
      link = new URL(item.link);
      if (link.protocol !== "https:" || link.hostname !== "publicalert.pagasa.dost.gov.ph") return [];
    } catch {
      return [];
    }
    const parsedDate = new Date(updatedAt);
    if (!title || !updatedAt || Number.isNaN(parsedDate.getTime())) return [];
    return [{
      id: createHash("sha256").update(link.href).digest("hex").slice(0, 20),
      title,
      updatedAt: parsedDate.toISOString(),
      url: link.href
    }];
  });
  cachedAdvisories = { fetchedAt: Date.now(), data };
  return { ...cachedAdvisories, cached: false };
}

function sendJson(response, status, body) {
  applySecurityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function text(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const review = record.review;
  if (!review || review.status !== "approved" || review.eventClosed !== true
    || !validDate(review.reviewedAt) || !validDate(review.publishAfter)
    || review.publishAfter > new Date().toISOString().slice(0, 10)) return null;

  const source = record.source && typeof record.source === "object" ? record.source : {};
  const category = text(record.category, 40);
  const theatre = text(record.theatre, 40);
  const perspective = text(record.perspective, 40);
  const confidence = text(record.confidence, 40);
  const sourceName = text(source.name, 120);
  const sourceUrl = text(source.url, 1000);
  let safeUrl = "";
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (["http:", "https:"].includes(parsed.protocol)) safeUrl = parsed.href;
    } catch {
      safeUrl = "";
    }
  }

  const eventDate = record.eventDate == null ? null : text(record.eventDate, 10);
  const publishedAt = record.publishedAt == null ? null : text(record.publishedAt, 10);
  if (!text(record.id, 100) || !text(record.title, 180) || !text(record.summary, 1200)
    || !text(record.locationLabel, 120) || !sourceName || !categories.has(category)
    || !theatres.has(theatre) || !perspectives.has(perspective) || !confidenceLevels.has(confidence)
    || (eventDate !== null && !validDate(eventDate))
    || (publishedAt !== null && !validDate(publishedAt))) return null;

  const today = new Date().toISOString().slice(0, 10);
  if ((eventDate && eventDate > today) || (publishedAt && publishedAt > today)) return null;

  return {
    id: text(record.id, 100),
    title: text(record.title, 180),
    summary: text(record.summary, 1200),
    category,
    theatre,
    locationLabel: text(record.locationLabel, 120),
    eventDate,
    publishedAt,
    source: { name: sourceName, url: safeUrl },
    perspective,
    confidence
  };
}

async function getArchive(url) {
  let file;
  try {
    file = await readFile(archivePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    file = "[]";
  }
  const storedRecords = JSON.parse(file);
  if (!Array.isArray(storedRecords)) throw new Error("Archive store must be a JSON array");
  let records = storedRecords.map(normalizeRecord).filter(Boolean);

  const category = url.searchParams.get("category");
  const theatre = url.searchParams.get("theatre");
  const perspective = url.searchParams.get("perspective");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (category && !categories.has(category)) return { error: "Unsupported category filter" };
  if (theatre && !theatres.has(theatre)) return { error: "Unsupported theatre filter" };
  if (perspective && !perspectives.has(perspective)) return { error: "Unsupported perspective filter" };
  if ((from && !validDate(from)) || (to && !validDate(to))) return { error: "Date filters must use YYYY-MM-DD" };

  records = records.filter((record) => {
    if (category && record.category !== category) return false;
    if (theatre && record.theatre !== theatre) return false;
    if (perspective && record.perspective !== perspective) return false;
    if (from && (!record.eventDate || record.eventDate < from)) return false;
    if (to && (!record.eventDate || record.eventDate > to)) return false;
    return true;
  }).sort((first, second) => (second.eventDate || second.publishedAt || "").localeCompare(first.eventDate || first.publishedAt || ""));

  return {
    data: records,
    meta: { generatedAt: new Date().toISOString(), count: records.length }
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
    return sendJson(response, 200, { status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
  }
  if (url.pathname.startsWith("/api/") && !applyApiRateLimit(request, response, url)) return;
  if (url.pathname.startsWith("/api/v1/admin/")) {
    if (!process.env.MATANGLAWIN_ADMIN_TOKEN) {
      return sendJson(response, 503, { error: "Admin API is disabled; configure MATANGLAWIN_ADMIN_TOKEN" });
    }
    if (!isAdminRequest(request)) return sendJson(response, 401, { error: "Unauthorized" });

    try {
      if (url.pathname === "/api/v1/admin/news" && request.method === "GET") {
        const items = await getNewsItems();
        return sendJson(response, 200, { data: items, meta: { count: items.length } });
      }
      if (url.pathname === "/api/v1/admin/ingest/run" && request.method === "POST") {
        if (Number(request.headers["content-length"] || 0) > 0 || request.headers["transfer-encoding"]) {
          return sendJson(response, 413, { error: "Request body is not accepted" });
        }
        const stats = await ingestFeeds();
        return sendJson(response, 200, { data: stats });
      }
      const exportMatch = url.pathname.match(/^\/api\/v1\/admin\/weekly-reports\/(\d{4}-\d{2}-\d{2})\/export$/);
      if (exportMatch && request.method === "GET") {
        const markdown = await exportWeeklyReport(exportMatch[1]);
        if (!markdown) return sendJson(response, 404, { error: "Weekly report not found" });
        response.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="matanglawin-${exportMatch[1]}.md"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(markdown);
        return;
      }
      if (url.pathname === "/api/v1/admin/weekly-reports" && request.method === "GET") {
        const reports = await getWeeklyReports();
        return sendJson(response, 200, { data: reports, meta: { count: reports.length } });
      }
      return sendJson(response, 404, { error: "Admin endpoint not found" });
    } catch {
      return sendJson(response, 500, { error: "Admin operation failed" });
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  if (url.pathname === "/api/v1/archive") {
    try {
      const result = await getArchive(url);
      if (result.error) return sendJson(response, 400, { error: result.error });
      return sendJson(response, 200, result);
    } catch {
      return sendJson(response, 500, { error: "Archive store unavailable" });
    }
  }

  if (url.pathname === "/api/v1/news" || url.pathname === "/api/v1/reports") {
    try {
      const data = url.pathname.endsWith("/news") ? await getNewsItems() : await getWeeklyReports();
      return sendJson(response, 200, { data, meta: { count: data.length, generatedAt: new Date().toISOString() } });
    } catch {
      return sendJson(response, 500, { error: "News archive unavailable" });
    }
  }

  if (url.pathname === "/api/v1/advisories" && (request.method === "GET" || request.method === "HEAD")) {
    try {
      const result = await getPublicAdvisories();
      return sendJson(response, 200, {
        data: result.data,
        meta: {
          count: result.data.length,
          fetchedAt: new Date(result.fetchedAt).toISOString(),
          cached: result.cached,
          source: "PAGASA public alerts",
          sourceUrl: pagasaFeedUrl,
          license: "CC BY 4.0"
        }
      });
    } catch {
      return sendJson(response, 502, { error: "PAGASA public advisories are temporarily unavailable", data: [] });
    }
  }

  const relativePath = staticFiles.get(url.pathname);
  if (!relativePath) return sendJson(response, 404, { error: "Not found" });
  const resolvedRoot = resolve(root);
  const filePath = resolve(resolvedRoot, relativePath);
  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${sep}`)) {
    return sendJson(response, 404, { error: "Not found" });
  }
  try {
    const body = await readFile(filePath);
    applySecurityHeaders(response);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self' https://unpkg.com https://*.tile.openstreetmap.org https://fonts.googleapis.com https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'"
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
});

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 40;

server.listen(port, host, () => {
  console.log(`Project Matanglawin archive available at http://${host}:${port}`);
  if (Number.isInteger(pollHours) && pollHours >= 1 && pollHours <= 168) {
    startScheduler(pollHours);
    ingestFeeds().then((stats) => {
      console.log(`Initial RSS poll complete: ${stats.candidatesAdded ?? 0} candidates added from ${stats.sourcesChecked ?? 0} sources`);
    }).catch(() => console.error("Initial RSS polling failed; check source and queue configuration"));
  } else {
    console.error("RSS polling is disabled: INGEST_INTERVAL_HOURS must be between 1 and 168");
  }
});
