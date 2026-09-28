import test from "node:test";
import assert from "node:assert/strict";
import { parsePageFacts, fetchPageFacts } from "../lib/page-facts.mjs";
import {
  buildObservedEvidence,
  enforceEvidence,
  isTokenSatisfied,
  NOT_OBSERVED_FROM_RSS,
} from "../lib/evidence.mjs";
import {
  PAGE_FACTS_MAX_PER_RUN,
  PAGE_FACTS_TIMEOUT_MS,
} from "../lib/constants.mjs";

const ITEM = {
  link: "https://blog.example.com/post",
  title: "Hello",
  summary: "Body",
  summarySource: "summary",
  pubDate: "2026-09-28T00:00:00Z",
  sourceName: "Example Feed",
};

test("parsePageFacts extracts host and meta author", () => {
  const html = `<!doctype html><html><head>
    <meta name="author" content="Ada Lovelace">
    <title>T</title>
  </head><body>x</body></html>`;
  const facts = parsePageFacts(html, "https://www.Example.com/post?utm=1");
  assert.equal(facts.ok, true);
  assert.equal(facts.ownerDomain, "example.com");
  assert.equal(facts.author, "Ada Lovelace");
});

test("parsePageFacts ignores URL authors and body text", () => {
  const html = `<html><head>
    <meta property="article:author" content="https://social.example/ada">
    <meta name="author" content="Grace Hopper">
  </head><body><meta name="author" content="Evil"></body></html>`;
  const facts = parsePageFacts(html, "https://example.com/a");
  assert.equal(facts.author, "Grace Hopper");
});

test("parsePageFacts rejects bad url / empty body", () => {
  assert.equal(parsePageFacts("<html></html>", "not a url").reason, "invalid-url");
  assert.equal(parsePageFacts("   ", "https://example.com/").reason, "empty-body");
  assert.equal(parsePageFacts("<html>x</html>", "ftp://example.com/").reason, "invalid-url");
});

test("page facts unlock official_domain and page_author tokens", () => {
  const observed = buildObservedEvidence(ITEM, {
    ok: true,
    ownerDomain: "blog.example.com",
    author: "Ada Lovelace",
  });
  assert.equal(observed.linked_page_owner_domain, "blog.example.com");
  assert.equal(observed.linked_page_author, "Ada Lovelace");
  assert.ok(!observed.notObserved.includes("linked_page_owner_domain"));
  assert.ok(!observed.notObserved.includes("linked_page_author"));
  assert.ok(observed.notObserved.includes("linked_page_content"));
  assert.equal(isTokenSatisfied("official_domain", observed), true);
  assert.equal(isTokenSatisfied("page_author", observed), true);
  assert.equal(isTokenSatisfied("page_content", observed), false);
});

test("without page facts, official_domain stays unsatisfied", () => {
  const observed = buildObservedEvidence(ITEM);
  assert.deepEqual(observed.notObserved, NOT_OBSERVED_FROM_RSS);
  assert.equal(isTokenSatisfied("official_domain", observed), false);
  assert.equal(isTokenSatisfied("page_author", observed), false);
});

test("enforceEvidence accepts page-fact contract when facts observed", () => {
  const observed = buildObservedEvidence(ITEM, {
    ok: true,
    ownerDomain: "openai.com",
    author: "OpenAI",
  });
  const rule = {
    id: "1-1",
    requiresEvidence: ["official_domain"],
    evidenceAny: [],
  };
  const result = enforceEvidence(
    {
      include: true,
      matchedRuleId: "1-1",
      categoryId: "model-releases",
      reason: "official post",
      evidenceStatus: "sufficient",
      evidenceCitations: ["title", "linked_page_owner_domain"],
    },
    observed,
    rule,
  );
  assert.equal(result.include, true);
});

test("enforceEvidence still denies page-fact contract when fetch missed", () => {
  const observed = buildObservedEvidence(ITEM, { ok: false, reason: "timeout" });
  const rule = {
    id: "1-1",
    requiresEvidence: ["official_domain"],
    evidenceAny: [],
  };
  const result = enforceEvidence(
    {
      include: true,
      matchedRuleId: "1-1",
      categoryId: "model-releases",
      reason: "x",
      evidenceStatus: "sufficient",
      evidenceCitations: ["title"],
    },
    observed,
    rule,
  );
  assert.equal(result.include, false);
  assert.match(String(result.reason), /evidence contract unmet/i);
});

test("page-fact caps stay inside the Actions budget", () => {
  assert.ok(PAGE_FACTS_MAX_PER_RUN >= 1 && PAGE_FACTS_MAX_PER_RUN <= 20);
  assert.ok(PAGE_FACTS_TIMEOUT_MS <= 8000);
  // Sequential worst-case page fetches must stay well under the 25-minute job.
  assert.ok(PAGE_FACTS_MAX_PER_RUN * PAGE_FACTS_TIMEOUT_MS <= 60_000);
});

test("fetchPageFacts rejects non-http without network", async () => {
  const res = await fetchPageFacts("ftp://example.com/");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid-url");
  assert.equal(res.fetched, false);
});
