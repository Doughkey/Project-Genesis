import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const storiesPath = resolve(root, "data", "news-items.json");
const reportsPath = resolve(root, "data", "weekly-reports.json");
const exportDirectory = resolve(root, "data", "exports");
const parser = new Parser({ maxRedirects: 0 });
const dayMs = 24 * 60 * 60 * 1000;
const maximumStoryAgeMs = 7 * dayMs;
const maximumFeedBytes = 1024 * 1024;
const maximumItemsPerSource = 80;
const maximumStoredStories = 2000;
const perspectives = new Set(["left", "center", "right", "unrated"]);
const acceptedContentTypes = ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml", "text/plain"];
const excludedOperationalTerms = /\b(?:afp|armed forces|troops?|deploy(?:ment|ed|ing)?|nav(?:y|al)|coast guard|military|insurgent|insurgency|npa|clash(?:es)?|raid(?:s|ed)?|attack(?:s|ed)?|strike(?:s|d)?|casualt(?:y|ies)|killed|wounded|operation(?:s|al)?|frontline|supply line|movement|patrol|vessel|warship|aircraft|weapon|missile|terror(?:ist|ism)?|combat|battle|war|exercise(?:s)?|base)\b/i;
const topicPatterns = [
  ["elections", /\b(?:election|comelec|polls?|ballot|candid(?:ate|acy)|campaign|voter registration)\b/i],
  ["diplomacy", /\b(?:dfa|foreign affairs|diplomac(?:y|tic)|ambassador|embassy|asean|summit|treaty|bilateral|foreign policy|consular)\b/i],
  ["legislation", /\b(?:senate|senator|house of representatives|congress|congressional|bill|legislation|lawmakers?|committee hearing|resolution)\b/i],
  ["courts-and-oversight", /\b(?:supreme court|court ruling|ombudsman|commission on audit|comelec en banc|impeachment|ethics complaint)\b/i],
  ["trade-and-economy", /\b(?:trade agreement|tariff|investment|exports?|imports?|economic policy|budget|tax reform|fiscal policy)\b/i],
  ["public-policy", /\b(?:president|cabinet|executive order|government policy|public policy|department secretary|national government)\b/i]
];
const philippinesContextPattern = /\b(?:philippin(?:e|es|o)|filipino|manila|comelec|davao|cebu)\b/i;
const coverageAreaPatterns = [
  ["luzon", /\b(?:luzon|metro manila|manila)\b/i],
  ["visayas", /\b(?:visayas|cebu|iloilo|leyte|bohol|negros|samar)\b/i],
  ["mindanao", /\b(?:mindanao|davao|cotabato|zamboanga|barmm|bangsamoro)\b/i],
  ["west-philippine-sea", /\bwest philippine sea\b/i]
];
const googlePolicyQuery = "Philippines (election OR senate OR legislation OR diplomacy OR foreign policy OR trade OR economy OR court) -military -troops -warship -deployment -clash -attack";
export const SOURCE_CATALOG = Object.freeze([
  Object.freeze({ id: "philstar-headlines", name: "The Philippine Star", feedUrl: "https://www.philstar.com/rss/headlines", perspective: "unrated", philippinesFocused: true }),
  Object.freeze({ id: "inquirer-news", name: "Inquirer News", feedUrl: "https://newsinfo.inquirer.net/feed", perspective: "unrated", philippinesFocused: true }),
  Object.freeze({ id: "bbc-asia", name: "BBC News · Asia", feedUrl: "https://feeds.bbci.co.uk/news/world/asia/rss.xml", perspective: "unrated", philippinesFocused: false }),
  Object.freeze({ id: "guardian-philippines", name: "The Guardian · Philippines", feedUrl: "https://www.theguardian.com/world/philippines/rss", perspective: "unrated", philippinesFocused: false }),
  Object.freeze({ id: "google-ph-policy-search", name: "Google News · Philippines policy query", feedUrl: `https://news.google.com/rss/search?q=${encodeURIComponent(googlePolicyQuery)}&hl=en-PH&gl=PH&ceid=PH:en`, perspective: "unrated", philippinesFocused: true, publisherInTitle: true })
]);
let running = false;

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function isPrivateIp(address) {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || octets[0] >= 224;
  }
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized.startsWith("::ffff:")) return isPrivateIp(normalized.slice(7));
  if (normalized === "::" || normalized === "::1") return true;
  const firstBlock = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return (firstBlock & 0xfe00) === 0xfc00
    || (firstBlock & 0xffc0) === 0xfe80
    || firstBlock < 0x2000
    || firstBlock >= 0x4000;
}

async function validateFeedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new Error("Feed URL must be a public HTTPS address");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Feed host did not resolve to a public address");
  }
  return url;
}

export async function readLimitedBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumFeedBytes) {
    throw new Error("Feed exceeds the size limit");
  }
  if (!response.body) throw new Error("Feed response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumFeedBytes) {
      await reader.cancel();
      throw new Error("Feed exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function fetchFeed(source) {
  const url = await validateFeedUrl(source.feedUrl);
  const response = await fetch(url, {
    headers: { Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!acceptedContentTypes.includes(contentType)) throw new Error("Feed returned an unsupported content type");
  const xml = await readLimitedBody(response);
  return parser.parseString(xml);
}

export function candidateFromItem(item, source, now = new Date()) {
  const rawDate = item.isoDate || item.pubDate;
  const publishedDate = rawDate ? new Date(rawDate) : null;
  if (!publishedDate || Number.isNaN(publishedDate.getTime())) return null;
  const ageMs = now.getTime() - publishedDate.getTime();
  if (ageMs < 0 || ageMs >= maximumStoryAgeMs) return null;

  const feedTitle = cleanText(item.title, 320);
  if (!feedTitle || excludedOperationalTerms.test(feedTitle)) return null;
  let title = feedTitle;
  let sourceName = cleanText(source.name, 120);
  if (source.publisherInTitle) {
    const separator = feedTitle.lastIndexOf(" - ");
    if (separator > 0) {
      title = cleanText(feedTitle.slice(0, separator), 240);
      sourceName = cleanText(feedTitle.slice(separator + 3), 120) || sourceName;
    }
  } else {
    title = cleanText(feedTitle, 240);
  }
  if (!title || excludedOperationalTerms.test(title)) return null;
  if (!source.philippinesFocused && !philippinesContextPattern.test(title)) return null;
  const topic = topicPatterns.find(([, pattern]) => pattern.test(title))?.[0];
  if (!topic) return null;
  let link;
  try {
    link = new URL(item.link);
    if (link.protocol !== "https:" || link.username || link.password) return null;
  } catch {
    return null;
  }
  const id = createHash("sha256").update(`${source.id}\n${link.href}`).digest("hex").slice(0, 24);
  const ageHours = ageMs / (60 * 60 * 1000);
  return {
    id,
    sourceId: source.id,
    sourceName,
    sourcePerspective: perspectives.has(source.perspective) ? source.perspective : "unrated",
    title,
    topic,
    coverageTheatres: coverageAreaPatterns.filter(([, pattern]) => pattern.test(title)).map(([theatre]) => theatre),
    url: link.href,
    publishedAt: publishedDate.toISOString(),
    collectedAt: now.toISOString(),
    retentionStage: ageHours < 24 ? "first-24-hours" : ageHours < 72 ? "24-to-72-hours" : "3-to-7-days"
  };
}

async function readArray(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeArrayAtomically(path, records) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function startOfWeek(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

export function buildWeeklyReport(weekStart, stories, now) {
  const weekEnd = new Date(weekStart.getTime() + 7 * dayMs);
  const inWeek = stories.filter((story) => {
    const published = new Date(story.publishedAt).getTime();
    return published >= weekStart.getTime() && published < weekEnd.getTime();
  }).sort((first, second) => second.publishedAt.localeCompare(first.publishedAt));
  const counts = (field) => Object.fromEntries([...new Set(inWeek.map((story) => story[field]))].sort().map((value) => [value, inWeek.filter((story) => story[field] === value).length]));
  const topicHighlights = Object.fromEntries([...new Set(inWeek.map((story) => story.topic))].sort().map((topic) => [
    topic,
    inWeek.filter((story) => story.topic === topic).slice(0, 3).map((story) => ({
      title: story.title,
      sourceName: story.sourceName,
      sourcePerspective: story.sourcePerspective,
      url: story.url
    }))
  ]));
  const reportId = weekStart.toISOString().slice(0, 10);
  return {
    id: reportId,
    weekStart: reportId,
    weekEnd: weekEnd.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    finalized: now.getTime() >= weekEnd.getTime(),
    expiresAt: new Date(weekEnd.getTime() + 30 * dayMs).toISOString(),
    exportedAt: null,
    summary: `${inWeek.length} policy-focused headlines from ${new Set(inWeek.map((story) => story.sourceId)).size} sources across ${Object.keys(topicHighlights).length} topics. Highlights below are extracted from source headlines, not AI-generated claims. Coverage counts are descriptive, not a measure of public opinion or truth.`,
    topicCounts: counts("topic"),
    perspectiveCounts: counts("sourcePerspective"),
    topicHighlights,
    items: inWeek.map(({ id, title, topic, sourceId, sourceName, sourcePerspective, url, publishedAt }) => ({
      id, title, topic, sourceId, sourceName, sourcePerspective, url, publishedAt
    }))
  };
}

async function updateRetention(now) {
  const stories = await readArray(storiesPath);
  const reports = await readArray(reportsPath);
  reports.forEach((item) => {
    if (!item.finalized && now.getTime() >= new Date(`${item.weekEnd}T00:00:00.000Z`).getTime()) {
      item.finalized = true;
      item.finalizedAt = now.toISOString();
    }
  });
  const weekStart = startOfWeek(now);
  const report = buildWeeklyReport(weekStart, stories, now);
  const existingIndex = reports.findIndex((item) => item.id === report.id);
  if (existingIndex >= 0) {
    report.exportedAt = reports[existingIndex].exportedAt || null;
    reports[existingIndex] = report;
  } else {
    reports.push(report);
  }

  const retainedReports = reports.filter((item) => item.exportedAt || new Date(item.expiresAt).getTime() > now.getTime());
  const retainedStories = stories.filter((story) => now.getTime() - new Date(story.publishedAt).getTime() < maximumStoryAgeMs);
  if (retainedStories.length !== stories.length) await writeArrayAtomically(storiesPath, retainedStories);
  await writeArrayAtomically(reportsPath, retainedReports);
  return { archivedReports: retainedReports.length, expiredStories: stories.length - retainedStories.length };
}

export async function ingestFeeds(now = new Date()) {
  if (running) return { skipped: true, reason: "An ingestion cycle is already running" };
  running = true;
  try {
    const stories = await readArray(storiesPath);
    const knownIds = new Set(stories.map((record) => record.id));
    const stats = { sourcesConfigured: SOURCE_CATALOG.length, sourcesChecked: 0, itemsSeen: 0, candidatesAdded: 0, itemsSkipped: 0, sourceErrors: [] };

    for (const source of SOURCE_CATALOG) {
      const sourceId = cleanText(source.id, 80);
      const sourceName = cleanText(source.name, 120);
      stats.sourcesChecked += 1;
      try {
        const feed = await fetchFeed(source);
        const items = Array.isArray(feed.items) ? feed.items.slice(0, maximumItemsPerSource) : [];
        stats.itemsSeen += items.length;
        for (const item of items) {
          const candidate = candidateFromItem(item, { ...source, id: sourceId, name: sourceName }, now);
          if (!candidate || knownIds.has(candidate.id)) {
            stats.itemsSkipped += 1;
            continue;
          }
          knownIds.add(candidate.id);
          stories.push(candidate);
          stats.candidatesAdded += 1;
        }
      } catch (error) {
        stats.sourceErrors.push({ sourceId, message: cleanText(error.message, 180) || "Feed fetch failed" });
      }
    }

    const retainedStories = stories.slice(-maximumStoredStories);
    await writeArrayAtomically(storiesPath, retainedStories);
    const retention = await updateRetention(now);
    stats.retention = retention;
    return stats;
  } finally {
    running = false;
  }
}

export async function getNewsItems(now = new Date()) {
  const stories = await readArray(storiesPath);
  return stories.filter((story) => now.getTime() - new Date(story.publishedAt).getTime() < maximumStoryAgeMs)
    .map((story) => {
      const source = SOURCE_CATALOG.find((item) => item.id === story.sourceId);
      let title = story.title;
      let sourceName = story.sourceName;
      if (source?.publisherInTitle && sourceName === source.name && typeof title === "string") {
        const separator = title.lastIndexOf(" - ");
        if (separator > 0) {
          sourceName = cleanText(title.slice(separator + 3), 120) || source.name;
          title = cleanText(title.slice(0, separator), 240);
        }
      }
      return {
        ...story,
        title,
        sourceName,
        coverageTheatres: Array.isArray(story.coverageTheatres) ? story.coverageTheatres : [],
        retentionStage: storyAgeStage(story, now)
      };
    })
    .sort((first, second) => second.publishedAt.localeCompare(first.publishedAt));
}

function storyAgeStage(story, now) {
  const ageHours = (now.getTime() - new Date(story.publishedAt).getTime()) / (60 * 60 * 1000);
  return ageHours < 24 ? "first-24-hours" : ageHours < 72 ? "24-to-72-hours" : "3-to-7-days";
}

export async function getWeeklyReports(now = new Date()) {
  const reports = await readArray(reportsPath);
  return reports.filter((report) => report.exportedAt || new Date(report.expiresAt).getTime() > now.getTime())
    .sort((first, second) => second.weekStart.localeCompare(first.weekStart));
}

export async function exportWeeklyReport(reportId, now = new Date()) {
  const reports = await readArray(reportsPath);
  const report = reports.find((item) => item.id === reportId);
  if (!report) return null;
  report.exportedAt ||= now.toISOString();
  await mkdir(exportDirectory, { recursive: true });
  const lines = [
    `# Matanglawin Weekly Brief · ${report.weekStart}`,
    "",
    report.summary,
    "",
    "## Coverage by topic",
    ...Object.entries(report.topicCounts).map(([topic, count]) => `- ${topic}: ${count}`),
    "",
    "## Extractive highlights by topic",
    ...Object.entries(report.topicHighlights || {}).flatMap(([topic, items]) => [
      `### ${topic}`,
      ...items.map((item) => `- [${item.title}](${item.url}) · ${item.sourceName} (${item.sourcePerspective})`),
      ""
    ]),
    "## Source perspective labels",
    ...Object.entries(report.perspectiveCounts).map(([perspective, count]) => `- ${perspective}: ${count}`),
    "",
    "## Source-linked headlines",
    ...report.items.map((item) => `- ${item.publishedAt.slice(0, 10)} · ${item.topic} · ${item.sourceName} (${item.sourcePerspective}): [${item.title}](${item.url})`),
    "",
    "Source-level coverage only; not a measure of public opinion or truth."
  ];
  const markdown = `${lines.join("\n")}\n`;
  await writeFile(resolve(exportDirectory, `${report.id}.md`), markdown, { mode: 0o600 });
  await writeArrayAtomically(reportsPath, reports);
  return markdown;
}

export function startScheduler(intervalHours = 3) {
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const timer = setInterval(() => {
    ingestFeeds().then((stats) => {
      console.log(`RSS poll complete: ${stats.candidatesAdded ?? 0} candidates added from ${stats.sourcesChecked ?? 0} sources`);
      if (stats.sourceErrors?.length) console.error(`RSS source errors: ${stats.sourceErrors.length}`);
    }).catch(() => console.error("RSS polling failed; check source and queue configuration"));
  }, intervalMs);
  timer.unref();
  return timer;
}
