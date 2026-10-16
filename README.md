# Project Matanglawin

Public-source archive interface prototype. The frontend can run by opening `index.html`; it uses clearly labeled demo records when opened from disk or when the archive API is unavailable.

## Run locally

Requires Node.js 20 or later. No package installation is needed.

```sh
npm start
```

Open `http://127.0.0.1:3000`. RSS polling runs immediately and every 3 hours by default; set `INGEST_INTERVAL_HOURS` from 1 to 168 to change the interval.

To keep polling after closing the browser or terminal, run the persistent container service:

```sh
docker compose up -d --build
```

The container uses `restart: unless-stopped` and a persistent data volume. It continues while the Docker host is running. `docker compose down` stops it. On Linux, host networking lets the container use the host's working DNS resolver; the app still binds to `127.0.0.1:3000`. Host networking reduces network isolation, so use this Compose profile only on a trusted Linux host. On other platforms, configure the container's DNS/proxy and use an isolated port mapping instead.

## Public deployment

The public profile is in `compose.production.yml`: the app has no published host port, Caddy provides automatic HTTPS, app/admin APIs are rate-limited, and the admin token is mandatory. Before launch, you need a Linux host with Docker/Compose, a real domain with A/AAAA DNS records pointing to that host, inbound TCP ports 80/443 (and UDP 443 for HTTP/3), and a secret admin token. Certificate issuance cannot complete before DNS and network reachability work.

```sh
cp deploy/production.env.example deploy/production.env
openssl rand -hex 32
# Edit deploy/production.env: set DOMAIN, ACME_EMAIL, and the generated token.
docker compose -f compose.production.yml --env-file deploy/production.env config --quiet
docker compose -f compose.production.yml --env-file deploy/production.env up -d --build
curl --fail https://YOUR_DOMAIN/healthz
```

`deploy/production.env` is ignored by Git and excluded from the Docker build context. Never commit it or paste its contents into logs. Caddy renews certificates automatically. The app requires at least a 32-character admin token in production, trusts forwarded client IPs only in this profile, and applies per-IP request limits. This is deployment scaffolding, not a substitute for host patching, backups, monitoring/alerting, incident response, or legal/publisher-term review. Public deployment is not complete until the domain and host requirements above are supplied and verified.

To make a manual backup of the production data volume, run `sh deploy/backup-data.sh`. It writes a timestamped archive under `backups/`, which is Git-ignored. Schedule this on the host and copy backups to a separate protected destination; test restores before relying on them. Set `MATANGLAWIN_DATA_VOLUME` only if you deliberately renamed the Compose volume.

**Deployment status:** the production profile is prepared and validated, but this workspace is not deployed publicly. Public read APIs are unauthenticated by design and rate-limited; admin routes require the configured secret token. A public launch still requires a real domain, correct DNS, reachable host ports 80/443, secret provisioning, and host-level backup/monitoring procedures.

## Frontend integration

The page loads `js/data-source.js`, which requests `GET /api/v1/archive` from the same origin. The adapter normalizes responses through an allowlist; extra fields such as coordinates are ignored. Feed content is rendered as text, and source links are restricted to HTTP(S). A separate API origin would need a same-origin reverse proxy or explicit CORS configuration; neither is enabled by this server.

The map covers five generalized theatre areas, not official administrative regions or province boundaries. Donut colors show source-perspective counts for reviewed archive records plus policy headlines that explicitly name a broad area (`Luzon`, `Visayas`, `Mindanao`, or `West Philippine Sea`). These are coverage mentions, not event locations, residents' political views, votes, or regional ideology. National headlines with no explicit area stay unmapped. Empty areas use a neutral marker. The map refreshes from the archive and policy feed every 15 minutes while open. No coordinates, unit locations, or operational map layers are used.

## Archive API contract

`GET /api/v1/archive` returns JSON in this shape:

```json
{
	"data": [
		{
			"id": "record-123",
			"title": "Example public-source summary",
			"summary": "A concise, source-attributed historical summary.",
			"category": "maritime",
			"theatre": "west-philippine-sea",
			"locationLabel": "Generalized maritime area",
			"eventDate": "2025-03-10",
			"publishedAt": "2025-03-12",
			"source": {
				"name": "Example publication",
				"url": "https://example.org/report"
			},
			"perspective": "unrated",
			"confidence": "reported"
		}
	],
	"meta": {
		"generatedAt": "2025-03-13T00:00:00Z"
	}
}
```

Allowed `category` values: `maritime`, `security`, `public`, `humanitarian`.

Allowed `theatre` values: `luzon`, `visayas`, `mindanao`, `west-philippine-sea`, `pacific`.

Allowed `perspective` values: `left`, `center`, `right`, `unrated`. These are documented outlet-level classifications, not assessments of whether a claim is true. The methodology for assigning them should be public and consistently applied.

Allowed `confidence` values: `confirmed`, `reported`, `unverified`. Dates use `YYYY-MM-DD`; `eventDate` and `publishedAt` may be `null` when unknown. Every record needs a source name; the source URL may be an empty string if no stable public link exists.

## Automated feed intake

The source catalog is fixed in `js/ingestion-worker.js`; there is no source-add UI, API, or editable source file. It currently includes verified public RSS feeds from The Philippine Star, Inquirer News, BBC Asia, The Guardian's Philippines feed, and a fixed Google News query scoped to Philippine elections, legislation, diplomacy, courts, trade, and economy. International feeds require explicit Philippine context in the headline. All outlets are `unrated` because no consistent, documented classification method has been adopted. This is a starting set, not a claim of full or balanced Philippine media coverage. New sources require a code review and endpoint verification before release. Al Jazeera's tested global feed did not yield Philippine-matched headlines, so it was not enabled. The Docker image runs with a read-only application filesystem; only the data volume is writable. This prevents in-container edits, but cannot stop a host administrator from rebuilding or replacing the image.

The worker polls RSS/Atom metadata only; it does not crawl arbitrary pages or store descriptions. Its preselected topic terms cover governance, legislation, elections, diplomacy, courts, and trade/economic policy. A separate exclusion filter rejects operational/conflict terms, and international results must match Philippine context. This filter is conservative and imperfect; it is not a substitute for editorial review. It stores headline, source URL/name, published date, topic, and outlet label only. The Google News query is a fixed URL in code, not a user-editable search box.

Stories are kept in three rolling stages: first 24 hours, 24–72 hours, and days 3–7. Items older than seven days are removed from the story store after being included in the rolling weekly report. Weekly reports summarize source and topic counts and group up to three cited headlines per topic; the text is extractive rather than generated, to avoid invented claims. Unexported reports expire 30 days after their week ends. Exporting a report marks it as retained and writes a Markdown copy under `data/exports/`.

The news panel also displays metadata-only entries from PAGASA's [Public Alerts Atom feed](https://publicalert.pagasa.dost.gov.ph/feeds/), verified as reachable during development. The endpoint displays each alert's title, update time, and official CAP link; it does not fetch the CAP body or plot alert locations. PAGASA identifies the feed as CC BY 4.0; attribution is shown in the interface. This public-weather feed is separate from policy news and is cached for ten minutes.

Feeds must use HTTPS, resolve to public addresses, not redirect, return an accepted XML content type, and stay under a 1 MB response limit. Polling is sequential, limited to 80 items per source per cycle, and de-duplicates by source and link. Undated items, future-dated items, non-policy headlines, and headlines matching the operational exclusion list are dropped.

Set an admin token in the server environment to enable the private poll/report-export endpoints:

```sh
MATANGLAWIN_ADMIN_TOKEN="use-a-long-random-secret-from-your-secret-manager" npm start
```

Use `GET /api/v1/news` for the current seven-day policy headline list and `GET /api/v1/reports` for weekly summaries. With `Authorization: Bearer <token>`, `POST /api/v1/admin/ingest/run` triggers a poll; `GET /api/v1/admin/weekly-reports` lists reports; `GET /api/v1/admin/weekly-reports/YYYY-MM-DD/export` exports one report. Admin endpoints return 503 until a token is configured and 401 for an invalid token. Do not commit the token or expose the service publicly without deployment-level authentication and HTTPS.

## Approved archive publication

The separate regional map archive is still review-gated. To publish a record there, add it to `data/archive.json` using the public record schema above, then add this approval metadata:

```json
{
	"review": {
		"status": "approved",
		"eventClosed": true,
		"reviewedAt": "2025-04-01",
		"publishAfter": "2025-06-01"
	}
}
```

Records remain hidden until the event is marked closed and `publishAfter` has passed. The server drops records that fail validation and returns only the public-field allowlist. `unrated` is the default for a source with no documented perspective methodology, mixed evidence, or insufficient basis to classify it; it is not an implicit center label.

## Data policy

This is an allowlisted RSS poller, not a universal website crawler. Sources must be policy-relevant public feeds and respect publisher terms. The automated policy wire filters to governance, legislation, elections, diplomacy, courts, and trade/economic policy; operational conflict content is excluded. There are no open source-add routes or runtime source configuration. Keep perspective as source metadata, mark unsupported classifications `unrated`, and never infer political sentiment from regional news counts. The political news feed does not create map positions or operational layers. Preserve attribution, uncertainty, and publication dates, and do not present allegations as verified facts.