(() => {
  const categories = new Set(["maritime", "security", "public", "humanitarian"]);
  const theatres = new Set(["luzon", "visayas", "mindanao", "west-philippine-sea", "pacific"]);
  const perspectives = new Set(["left", "center", "right", "unrated"]);
  const confidenceLevels = new Set(["confirmed", "reported", "unverified"]);

  function asText(value, field, required = false) {
    if (typeof value !== "string") {
      if (required) throw new Error(`Invalid archive field: ${field}`);
      return "";
    }
    const result = value.trim();
    if (required && !result) throw new Error(`Missing archive field: ${field}`);
    return result;
  }

  function asDate(value, field) {
    if (value == null || value === "") return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`Invalid archive date: ${field}`);
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`Invalid archive date: ${field}`);
    }
    return value;
  }

  function safeSourceUrl(value) {
    const candidate = asText(value, "source.url");
    if (!candidate) return "";
    try {
      const url = new URL(candidate);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function normalizeRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid archive record");
    }
    const source = record.source && typeof record.source === "object" ? record.source : {};
    const normalized = {
      id: asText(record.id, "id", true),
      title: asText(record.title, "title", true),
      summary: asText(record.summary, "summary", true),
      category: asText(record.category, "category", true),
      theatre: asText(record.theatre, "theatre", true),
      locationLabel: asText(record.locationLabel, "locationLabel", true),
      eventDate: asDate(record.eventDate, "eventDate"),
      publishedAt: asDate(record.publishedAt, "publishedAt"),
      source: {
        name: asText(source.name, "source.name", true),
        url: safeSourceUrl(source.url)
      },
      perspective: asText(record.perspective, "perspective", true),
      confidence: asText(record.confidence, "confidence", true)
    };
    if (!categories.has(normalized.category) || !theatres.has(normalized.theatre)
      || !perspectives.has(normalized.perspective) || !confidenceLevels.has(normalized.confidence)) {
      throw new Error("Archive record contains an unsupported classification");
    }
    return normalized;
  }

  async function loadArchive() {
    if (window.location.protocol === "file:") {
      return { records: [], mode: "unavailable", meta: null };
    }

    const apiBase = (window.MATANGLAWIN_API_BASE_URL || "").replace(/\/$/, "");
    const endpoint = new URL(`${apiBase}/api/v1/archive`, window.location.href);
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Archive API is unavailable");
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.data)) throw new Error("Invalid archive response");
      return {
        records: payload.data.map(normalizeRecord),
        mode: "archive",
        meta: payload.meta && typeof payload.meta === "object" ? payload.meta : null
      };
    } catch {
      return { records: [], mode: "unavailable", meta: null };
    }
  }

  window.MatanglawinData = Object.freeze({ loadArchive });
})();
