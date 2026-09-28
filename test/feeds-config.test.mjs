import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTENT_MAX_AGE_DAYS,
  effectiveMaxAgeDays,
  isCategory,
  DEFAULT_SOURCE_MAX_PER_RUN,
} from "../lib/constants.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadFeeds() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "feeds.json"), "utf8"));
}

test("feeds.json is well-formed and every source is valid", () => {
  const feeds = loadFeeds();
  assert.ok(Array.isArray(feeds.rss), "feeds.rss must be an array");
  assert.ok(feeds.rss.length >= 11, "expected the original set plus expansions");

  const names = new Set();
  const urls = new Set();
  for (const feed of feeds.rss) {
    assert.equal(typeof feed.name, "string");
    assert.ok(feed.name.trim().length > 0, "name required");
    assert.equal(typeof feed.url, "string");
    assert.match(feed.url, /^https:\/\//, `${feed.name}: url must be https`);
    assert.ok(isCategory(feed.category), `${feed.name}: unknown category ${feed.category}`);
    if (feed.maxPerRun !== undefined) {
      assert.ok(Number.isInteger(feed.maxPerRun) && feed.maxPerRun > 0, `${feed.name}: maxPerRun`);
    }
    if (feed.maxAgeDays !== undefined) {
      assert.ok(Number.isFinite(feed.maxAgeDays) && feed.maxAgeDays > 0, `${feed.name}: maxAgeDays`);
    }
    assert.ok(!names.has(feed.name), `duplicate name ${feed.name}`);
    assert.ok(!urls.has(feed.url), `duplicate url ${feed.url}`);
    names.add(feed.name);
    urls.add(feed.url);
  }
});

test("phase-0 expansion sources are present with tight caps", () => {
  const byName = new Map(loadFeeds().rss.map((f) => [f.name, f]));
  for (const name of [
    "Hacker News Front Page",
    "Techmeme",
    "r/MachineLearning new",
    "r/LocalLLaMA new",
    "Ollama releases",
    "vLLM releases",
  ]) {
    assert.ok(byName.has(name), `missing ${name}`);
    assert.ok(byName.get(name).maxPerRun <= 5, `${name} must stay tightly capped`);
  }
  // Community feeds must not dominate research share.
  assert.ok((byName.get("r/MachineLearning new").maxPerRun ?? DEFAULT_SOURCE_MAX_PER_RUN) <= 3);
  assert.ok((byName.get("r/LocalLLaMA new").maxPerRun ?? DEFAULT_SOURCE_MAX_PER_RUN) <= 3);
});

test("effectiveMaxAgeDays defaults to the shared window", () => {
  assert.equal(effectiveMaxAgeDays({}), CONTENT_MAX_AGE_DAYS);
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: undefined }), CONTENT_MAX_AGE_DAYS);
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: "nope" }), CONTENT_MAX_AGE_DAYS);
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: 0 }), CONTENT_MAX_AGE_DAYS);
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: -3 }), CONTENT_MAX_AGE_DAYS);
});

test("effectiveMaxAgeDays may tighten but never exceed the shared window", () => {
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: 2 }), 2);
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: 1 }), 1);
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: CONTENT_MAX_AGE_DAYS }), CONTENT_MAX_AGE_DAYS);
  // Longer windows would ingest items the shared edition drops at display time.
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: 14 }), CONTENT_MAX_AGE_DAYS);
  assert.equal(effectiveMaxAgeDays({ maxAgeDays: 365 }), CONTENT_MAX_AGE_DAYS);
});
