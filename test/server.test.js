import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

let child;
let baseUrl;
const adminToken = "matanglawin-test-token";

async function getAvailablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/archive`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Test server did not start in time");
}

before(async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      INGEST_INTERVAL_HOURS: "0",
      ADMIN_API_RATE_LIMIT: "2",
      MATANGLAWIN_ADMIN_TOKEN: adminToken
    },
    stdio: "ignore"
  });
  await waitForServer();
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
});

test("serves live UI and public APIs without demo records", async () => {
  const [pageResponse, newsResponse, reportResponse, archiveResponse, healthResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/api/v1/news`),
    fetch(`${baseUrl}/api/v1/reports`),
    fetch(`${baseUrl}/api/v1/archive`),
    fetch(`${baseUrl}/healthz`)
  ]);
  const page = await pageResponse.text();
  const news = await newsResponse.json();
  const reports = await reportResponse.json();
  const archive = await archiveResponse.json();

  assert.equal(pageResponse.status, 200);
  assert.match(page, /Philippine politics & policy/);
  assert.doesNotMatch(page, /Demo fallback|Demo entries|PREVIEW MODE/);
  assert.equal(newsResponse.status, 200);
  assert.equal(reportResponse.status, 200);
  assert.equal(archiveResponse.status, 200);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).status, "ok");
  assert.equal(healthResponse.headers.get("x-frame-options"), "DENY");
  assert.ok(Array.isArray(news.data));
  assert.ok(Array.isArray(reports.data));
  assert.ok(Array.isArray(archive.data));
  for (const item of news.data) {
    assert.ok(Array.isArray(item.coverageTheatres));
    assert.equal("latitude" in item, false);
    assert.equal("longitude" in item, false);
  }
});

test("restricts unsupported methods, source-management routes, and invalid filters", async () => {
  const [methodResponse, sourceResponse, filterResponse] = await Promise.all([
    fetch(`${baseUrl}/api/v1/news`, { method: "POST" }),
    fetch(`${baseUrl}/api/v1/admin/sources`, { headers: { Authorization: `Bearer ${adminToken}` } }),
    fetch(`${baseUrl}/api/v1/archive?theatre=unknown`)
  ]);

  assert.equal(methodResponse.status, 405);
  assert.equal(sourceResponse.status, 404);
  assert.equal(filterResponse.status, 400);
});

test("requires the admin token for private report and ingestion routes", async () => {
  const unauthorized = await fetch(`${baseUrl}/api/v1/admin/weekly-reports`);
  const authorized = await fetch(`${baseUrl}/api/v1/admin/weekly-reports`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(authorized.status, 200);
});

test("rate-limits admin endpoints and returns retry metadata", async () => {
  const response = await fetch(`${baseUrl}/api/v1/admin/weekly-reports`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.ok(Number(response.headers.get("ratelimit-limit")) === 2);
});

test("rejects bodies on the admin poll trigger", async () => {
  const response = await fetch(`${baseUrl}/api/v1/admin/ingest/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 413);
});

test("refuses production startup without a strong admin token", () => {
  const result = spawnSync(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "production", MATANGLAWIN_ADMIN_TOKEN: "short", PORT: "0" },
    encoding: "utf8",
    timeout: 3000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MATANGLAWIN_ADMIN_TOKEN must be set/);
});
