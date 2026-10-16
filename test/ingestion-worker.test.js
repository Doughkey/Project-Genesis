import test from "node:test";
import assert from "node:assert/strict";
import { buildWeeklyReport, candidateFromItem, SOURCE_CATALOG } from "../js/ingestion-worker.js";

const now = new Date("2026-10-16T12:00:00.000Z");
const source = { id: "sample-source", name: "Sample Publisher", perspective: "unrated", philippinesFocused: true };

test("accepts policy headlines from the last seven days and labels retention stage", () => {
  const recentItem = candidateFromItem({
    title: "Senate committee advances election reform bill",
    link: "https://news.example.org/report/1",
    isoDate: "2026-10-16T08:00:00.000Z"
  }, source, now);
  const oldItem = candidateFromItem({
    title: "Senate passed a trade agreement",
    link: "https://news.example.org/report/2",
    isoDate: "2026-10-01T08:00:00.000Z"
  }, source, now);

  assert.equal(recentItem.retentionStage, "first-24-hours");
  assert.equal(recentItem.topic, "elections");
  assert.equal(recentItem.sourcePerspective, "unrated");
  assert.equal(oldItem, null);
});

test("assigns the 24-to-72-hour and 3-to-7-day retention stages", () => {
  const sourceItem = (publishedAt) => candidateFromItem({
    title: "Senate committee advances election reform bill",
    link: `https://news.example.org/${publishedAt}`,
    isoDate: publishedAt
  }, source, now);

  assert.equal(sourceItem("2026-10-15T00:00:00.000Z").retentionStage, "24-to-72-hours");
  assert.equal(sourceItem("2026-10-11T12:00:00.000Z").retentionStage, "3-to-7-days");
  assert.equal(sourceItem("2026-10-09T12:00:00.000Z"), null);
});

test("excludes undated, non-policy, and operational headlines", () => {
  assert.equal(candidateFromItem({ title: "Undated", link: "https://news.example.org/a" }, source, now), null);
  assert.equal(candidateFromItem({ title: "Celebrity interview", link: "https://news.example.org/a", isoDate: "2026-10-16T08:00:00.000Z" }, source, now), null);
  assert.equal(candidateFromItem({ title: "Troops deploy after clash", link: "https://news.example.org/a", isoDate: "2026-10-16T08:00:00.000Z" }, source, now), null);
  assert.equal(candidateFromItem({ title: "Senate passes a bill", link: "http://news.example.org/a", isoDate: "2026-10-16T08:00:00.000Z" }, source, now), null);
});

test("stores headline metadata only and strips markup from titles", () => {
  const candidate = candidateFromItem({
    title: "<b>DFA</b> discusses ASEAN treaty agenda",
    link: "https://news.example.org/report/3",
    isoDate: "2026-10-16T08:00:00.000Z",
    content: "Do not store article text",
    latitude: 18.2,
    longitude: 121.5
  }, source, now);

  assert.equal(candidate.title, "DFA discusses ASEAN treaty agenda");
  assert.equal(candidate.topic, "diplomacy");
  assert.equal("content" in candidate, false);
  assert.equal("latitude" in candidate, false);
  assert.equal("longitude" in candidate, false);
});

test("keeps source selection fixed and generates an attributed weekly coverage summary", () => {
  assert.deepEqual(SOURCE_CATALOG.map(({ id }) => id), ["philstar-headlines", "inquirer-news", "bbc-asia", "guardian-philippines", "google-ph-policy-search"]);
  const report = buildWeeklyReport(new Date("2026-10-12T00:00:00.000Z"), [{
    id: "headline-1",
    title: "Senate advances election reform bill",
    topic: "elections",
    sourceId: "inquirer-news",
    sourceName: "Inquirer News",
    sourcePerspective: "unrated",
    url: "https://news.example.org/story",
    publishedAt: "2026-10-14T10:00:00.000Z"
  }], new Date("2026-10-16T12:00:00.000Z"));

  assert.equal(report.finalized, false);
  assert.equal(report.items.length, 1);
  assert.equal(report.topicCounts.elections, 1);
  assert.equal(report.perspectiveCounts.unrated, 1);
  assert.equal(report.expiresAt, "2026-11-18T00:00:00.000Z");
  assert.equal(buildWeeklyReport(new Date("2026-10-12T00:00:00.000Z"), [], new Date("2026-10-19T00:00:00.000Z")).finalized, true);
});

test("international search results require a Philippines context and retain publisher attribution", () => {
  const internationalSource = { id: "fixed-query", name: "Google News query", perspective: "unrated", philippinesFocused: false, publisherInTitle: true };
  const unrelated = candidateFromItem({
    title: "Senate advances election reform bill - Example Global News",
    link: "https://news.example.org/unrelated",
    isoDate: "2026-10-16T08:00:00.000Z"
  }, internationalSource, now);
  const philippines = candidateFromItem({
    title: "Philippines advances election reform bill - Example Global News",
    link: "https://news.example.org/philippines",
    isoDate: "2026-10-16T08:00:00.000Z"
  }, internationalSource, now);

  assert.equal(unrelated, null);
  assert.equal(philippines.title, "Philippines advances election reform bill");
  assert.equal(philippines.sourceName, "Example Global News");
});

test("fixed Google News catalog settings survive ingestion normalization", () => {
  const googleSource = SOURCE_CATALOG.find((item) => item.id === "google-ph-policy-search");
  const candidate = candidateFromItem({
    title: "Philippines advances election reform bill - Example Global News",
    link: "https://news.example.org/catalog-source",
    isoDate: "2026-10-16T08:00:00.000Z"
  }, googleSource, now);

  assert.equal(candidate.sourceName, "Example Global News");
  assert.equal(candidate.topic, "elections");
});

test("map coverage uses only explicit broad-area mentions from policy headlines", () => {
  const candidate = candidateFromItem({
    title: "Cebu lawmakers discuss regional trade policy",
    link: "https://news.example.org/cebu-policy",
    isoDate: "2026-10-16T08:00:00.000Z"
  }, source, now);
  const nationalCandidate = candidateFromItem({
    title: "Senate discusses national tax reform",
    link: "https://news.example.org/national-policy",
    isoDate: "2026-10-16T08:00:00.000Z"
  }, source, now);

  assert.deepEqual(candidate.coverageTheatres, ["visayas"]);
  assert.deepEqual(nationalCandidate.coverageTheatres, []);
});
