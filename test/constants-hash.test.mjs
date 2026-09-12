import test from "node:test";
import assert from "node:assert/strict";
import { isCategory, stageForStars, CATEGORIES } from "../lib/constants.mjs";
import { urlHash, normalizeUrl } from "../lib/hash.mjs";

test("isCategory only accepts known slugs", () => {
  for (const id of Object.keys(CATEGORIES)) {
    assert.equal(isCategory(id), true);
  }
  assert.equal(isCategory("evil"), false);
  assert.equal(isCategory(""), false);
  assert.equal(isCategory(null), false);
});

test("stageForStars thresholds", () => {
  assert.deepEqual(stageForStars(0), { stage: "S0", stars: 0, quorum: 1 });
  assert.deepEqual(stageForStars(199).quorum, 1);
  assert.deepEqual(stageForStars(200), { stage: "S1", stars: 200, quorum: 5 });
  assert.deepEqual(stageForStars(999).quorum, 5);
  assert.equal(stageForStars(1500).stage, "S2");
  assert.equal(stageForStars(1500).quorum, Math.floor(1500 / 100) + 1);
});

test("urlHash ignores tracking params and fragment", () => {
  assert.equal(
    urlHash("https://Example.com/a?utm_source=x#frag"),
    urlHash("https://example.com/a"),
  );
  assert.notEqual(
    urlHash("https://example.com/a"),
    urlHash("https://example.com/b"),
  );
});

test("normalizeUrl strips utm_*", () => {
  assert.equal(normalizeUrl("https://x.com/a?utm_source=y&utm_medium=z"), "https://x.com/a");
});
