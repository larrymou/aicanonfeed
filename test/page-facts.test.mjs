import test from "node:test";
import assert from "node:assert/strict";
import { parsePageFacts, fetchPageFacts, isBlockedHostname } from "../lib/page-facts.mjs";
import {
  buildObservedEvidence,
  enforceEvidence,
  isTokenSatisfied,
  NOT_OBSERVED_FROM_RSS,
  contractNeedsPageFacts,
  ruleEvidenceContract,
} from "../lib/evidence.mjs";
import {
  PAGE_FACTS_MAX_PER_RUN,
  PAGE_FACTS_TIMEOUT_MS,
} from "../lib/constants.mjs";
import { EVIDENCE_ENGINE_VERSION } from "../lib/fingerprint.mjs";

test("evidence engine version pins page-fact adjudication semantics", () => {
  // v3: linked_page_* observations + citation aliases (must bump on further semantic change)
  assert.equal(EVIDENCE_ENGINE_VERSION, "3");
});

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

test("parsePageFacts rejects non-HTML bodies even with a valid URL", () => {
  // Empty/missing content-type must not treat JSON/text as observed page facts.
  assert.equal(parsePageFacts('{"ok":true}', "https://example.com/api").reason, "not_html");
  assert.equal(parsePageFacts("just plain text", "https://example.com/t").reason, "not_html");
  assert.equal(parsePageFacts("PK\u0003\u0004binary", "https://example.com/f").reason, "not_html");
  const html = "<!DOCTYPE html><html><head><title>t</title></head></html>";
  assert.equal(parsePageFacts(html, "https://example.com/").ok, true);
});

test("parsePageFacts accepts HTML with long prolog/comment before root", () => {
  const long = `<!-- ${"x".repeat(4000)} -->\n<!DOCTYPE html><html><head>
    <meta name="author" content="Ada"></head></html>`;
  const facts = parsePageFacts(long, "https://example.com/p");
  assert.equal(facts.ok, true);
  assert.equal(facts.author, "Ada");
  const xml = `<?xml version="1.0"?><!DOCTYPE html><html><head></head></html>`;
  assert.equal(parsePageFacts(xml, "https://example.com/p").ok, true);
});

test("citation aliases accept token and camelCase names", () => {
  const observed = buildObservedEvidence(ITEM, {
    ok: true,
    ownerDomain: "openai.com",
    author: "OpenAI",
  });
  for (const citations of [
    ["official_domain", "page_author"],
    ["linkedPageOwnerDomain", "linkedPageAuthor"],
    ["linked_page_owner_domain", "linked_page_author"],
  ]) {
    const result = enforceEvidence(
      {
        include: true,
        matchedRuleId: "1-1",
        categoryId: "model-releases",
        reason: "official",
        evidenceStatus: "sufficient",
        evidenceCitations: citations,
      },
      observed,
      { id: "1-1", requiresEvidence: ["official_domain", "page_author"], evidenceAny: [] },
    );
    assert.equal(result.include, true, `${citations.join(",")}: ${result.reason}`);
  }
});

test("unobserved page-fact citations are dropped, not a platform veto", () => {
  // Contract only needs link; model also names page fields that were not fetched.
  const observed = buildObservedEvidence(ITEM);
  const rule = { id: "1-1", requiresEvidence: ["link"], evidenceAny: [] };
  const result = enforceEvidence(
    {
      include: true,
      matchedRuleId: "1-1",
      categoryId: "model-releases",
      reason: "owner site",
      evidenceStatus: "sufficient",
      evidenceCitations: ["title", "official_domain", "linked_page_author", "page_content"],
    },
    observed,
    rule,
  );
  assert.equal(result.include, true, result.reason);
  assert.deepEqual(result.evidenceCitations, ["title"]);

  // Only unobserved page-fact cites → still no include (no observed support).
  const onlyPage = enforceEvidence(
    {
      include: true,
      matchedRuleId: "1-1",
      categoryId: "model-releases",
      reason: "x",
      evidenceStatus: "sufficient",
      evidenceCitations: ["official_domain"],
    },
    observed,
    rule,
  );
  assert.equal(onlyPage.include, false);
  assert.match(String(onlyPage.reason), /without citations/);

  // Invented field names remain fatal.
  const invented = enforceEvidence(
    {
      include: true,
      matchedRuleId: "1-1",
      categoryId: "model-releases",
      reason: "x",
      evidenceStatus: "sufficient",
      evidenceCitations: ["title", "trust_me_bro"],
    },
    observed,
    rule,
  );
  assert.equal(invented.include, false);
  assert.match(String(invented.reason), /citation not observed/);
});

test("repo_link citation aliases to link and does not force-reject", () => {
  const observed = buildObservedEvidence(ITEM);
  const rule = {
    id: "5-1",
    requiresEvidence: [],
    evidenceAny: [["repo_link"], ["official_domain"]],
  };
  // Use a repo-shaped link for the alias path.
  const repoObserved = buildObservedEvidence({
    ...ITEM,
    link: "https://github.com/openai/openai-python",
  });
  const out = enforceEvidence(
    {
      include: true,
      matchedRuleId: "5-1",
      categoryId: "tools-oss",
      reason: "oss",
      evidenceStatus: "sufficient",
      evidenceCitations: ["repo_link", "title"],
    },
    repoObserved,
    rule,
  );
  assert.equal(out.include, true, out.reason);
  assert.deepEqual(out.evidenceCitations, ["repo_link", "title"]);

  // Non-repo link: contract must still fail (token gate unchanged).
  const deny = enforceEvidence(
    {
      include: true,
      matchedRuleId: "5-1",
      categoryId: "tools-oss",
      reason: "x",
      evidenceStatus: "sufficient",
      evidenceCitations: ["repo_link", "title"],
    },
    observed,
    rule,
  );
  assert.equal(deny.include, false);
  assert.match(String(deny.reason), /evidence contract unmet/);
});

test("false repo_link citation is invalid even when contract only needs link", () => {
  // Audit boundary: do not record repo_link on a non-repo URL.
  const observed = buildObservedEvidence(ITEM); // blog.example.com
  const rule = { id: "x", requiresEvidence: ["link"], evidenceAny: [] };
  const out = enforceEvidence(
    {
      include: true,
      matchedRuleId: "x",
      categoryId: "industry",
      reason: "r",
      evidenceStatus: "sufficient",
      evidenceCitations: ["repo_link", "title"],
    },
    observed,
    rule,
  );
  assert.equal(out.include, false);
  assert.match(String(out.reason), /citation not observed/);
});

test("non-string citation entries are dropped, not coerced", () => {
  const observed = buildObservedEvidence(ITEM);
  const rule = { id: "x", requiresEvidence: ["link"], evidenceAny: [] };
  const out = enforceEvidence(
    {
      include: true,
      matchedRuleId: "x",
      categoryId: "industry",
      reason: "r",
      evidenceStatus: "sufficient",
      evidenceCitations: ["title", null, undefined, "", 0],
    },
    observed,
    rule,
  );
  assert.equal(out.include, true, out.reason);
  assert.deepEqual(out.evidenceCitations, ["title"]);
});

test("duplicate citations are collapsed in order", () => {
  const observed = buildObservedEvidence(ITEM);
  const rule = { id: "x", requiresEvidence: ["link"], evidenceAny: [] };
  const out = enforceEvidence(
    {
      include: true,
      matchedRuleId: "x",
      categoryId: "industry",
      reason: "r",
      evidenceStatus: "sufficient",
      evidenceCitations: ["title", "link", "title", "link"],
    },
    observed,
    rule,
  );
  assert.equal(out.include, true, out.reason);
  assert.deepEqual(out.evidenceCitations, ["title", "link"]);
});

test("parsePageFacts accepts unquoted meta author content", () => {
  const html = "<html><head><meta name=author content=Ada></head></html>";
  const facts = parsePageFacts(html, "https://example.com/p");
  assert.equal(facts.ok, true);
  assert.equal(facts.author, "Ada");
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

test("isBlockedHostname blocks loopback, private, and metadata hosts", () => {
  for (const h of [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254",
    "metadata.google.internal",
    "[::1]",
    "fe80::1",
  ]) {
    assert.equal(isBlockedHostname(h), true, h);
  }
  assert.equal(isBlockedHostname("example.com"), false);
  assert.equal(isBlockedHostname("github.com"), false);
});

test("isBlockedHostname blocks DNS names that map to loopback", () => {
  for (const h of [
    "localtest.me",
    "www.localtest.me",
    "127.0.0.1.nip.io",
    "foo.nip.io",
    "nip.io",
    "vcap.me",
    "app.vcap.me",
    "x.lvh.me",
    "127.0.0.1.sslip.io",
    "a.xip.io",
    "localho.st",
  ]) {
    assert.equal(isBlockedHostname(h), true, h);
  }
  assert.equal(isBlockedHostname("example.com"), false);
  assert.equal(isBlockedHostname("github.io"), false);
});

test("parsePageFacts refuses localhost-mapper hosts", () => {
  const facts = parsePageFacts("<html></html>", "https://localtest.me/");
  assert.equal(facts.ok, false);
  assert.equal(facts.reason, "blocked-host");
  const nip = parsePageFacts("<html></html>", "https://127.0.0.1.nip.io/");
  assert.equal(nip.ok, false);
  assert.equal(nip.reason, "blocked-host");
});

test("isBlockedHostname treats trailing-dot hosts as the same host", () => {
  for (const h of [
    "localtest.me.",
    "www.localtest.me.",
    "127.0.0.1.nip.io.",
    "localhost.",
    "127.0.0.1.",
    "169.254.169.254.",
  ]) {
    assert.equal(isBlockedHostname(h), true, h);
  }
  assert.equal(isBlockedHostname("example.com."), false);
  assert.equal(isBlockedHostname("github.com.."), false);
});

test("fetchPageFacts refuses blocked hosts before any request", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://localhost/x",
    "https://169.254.169.254/latest/meta-data/",
    "http://192.168.0.1/admin",
    "https://localtest.me/",
    "https://localtest.me./",
    "https://www.localtest.me./",
    "https://127.0.0.1.nip.io/",
    "https://app.vcap.me/",
  ]) {
    const res = await fetchPageFacts(url);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "blocked-host", url);
    assert.equal(res.fetched, false);
  }
});

test("contractNeedsPageFacts only when page-fact tokens appear", () => {
  assert.equal(contractNeedsPageFacts({ all: ["title"], any: [["link"]] }), false);
  assert.equal(contractNeedsPageFacts({ all: ["official_domain"], any: [] }), true);
  assert.equal(contractNeedsPageFacts({ all: [], any: [["repo_link"], ["page_author"]] }), true);
  assert.equal(contractNeedsPageFacts(ruleEvidenceContract({
    requiresEvidence: ["link"],
    evidenceAny: [["summary", "official_domain"]],
  })), true);
  assert.equal(contractNeedsPageFacts(ruleEvidenceContract({
    requiresEvidence: ["link"],
    evidenceAny: [["summary"]],
  })), false);
});
