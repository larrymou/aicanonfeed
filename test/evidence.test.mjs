import test from "node:test";
import assert from "node:assert/strict";
import {
  buildObservedEvidence,
  enforceEvidence,
  ruleEvidenceContract,
  satisfiesEvidenceContract,
  parseEvidenceAny,
  parseEvidenceContractSection,
  isTokenSatisfied,
  isRepoUrl,
  normalizeEvidenceContract,
  contractForRuleBuild,
  isRssObservableToken,
  contractHasRssPath,
} from "../lib/evidence.mjs";

const observedFull = buildObservedEvidence({
  title: "Acme ships Model X",
  link: "https://blog.acme.com/model-x",
  pubDate: "2026-09-24T00:00:00.000Z",
  summary: "Acme announced Model X today.",
  sourceName: "Example Feed",
});

const observedRepo = buildObservedEvidence({
  title: "Tool launched",
  link: "https://github.com/acme/tool",
  pubDate: "2026-09-24T00:00:00.000Z",
  summary: "Open source tool",
  sourceName: "Feed",
});

const observedNews = buildObservedEvidence({
  title: "Story",
  link: "https://techcrunch.com/2026/09/23/some-story/",
  pubDate: "2026-09-24T00:00:00.000Z",
  summary: "A story",
  sourceName: "TechCrunch",
});

const okInclude = {
  include: true,
  matchedRuleId: "5-1",
  categoryId: "tools-oss",
  evidenceStatus: "sufficient",
  evidenceCitations: ["title", "link", "linkHost"],
  reason: "new tool with repo link",
};

test("buildObservedEvidence records only RSS-level facts", () => {
  assert.equal(observedFull.titlePresent, true);
  assert.equal(observedFull.linkHost, "blog.acme.com");
  assert.equal(observedFull.pubDate, "2026-09-24T00:00:00.000Z");
  assert.ok(observedFull.notObserved.includes("linked_page_author"));
  assert.ok(observedFull.notObserved.includes("linked_page_content"));
});

test("isRepoUrl requires a real repository URL", () => {
  assert.equal(isRepoUrl("https://github.com/openai/gpt-4"), true);
  assert.equal(isRepoUrl("https://gitlab.com/org/repo"), true);
  assert.equal(isRepoUrl("https://example.com/foo/bar.git"), true);
  assert.equal(isRepoUrl("https://techcrunch.com/2026/09/23/some-story/"), false);
  assert.equal(isRepoUrl("https://blog.acme.com/model-x"), false);
  assert.equal(isRepoUrl("https://github.com/openai"), false);
  assert.equal(isRepoUrl("https://github.com/"), false);
  assert.equal(isRepoUrl(""), false);
  // Site pages on code hosts are not repos
  assert.equal(isRepoUrl("https://github.com/topics/ai"), false);
  assert.equal(isRepoUrl("https://github.com/settings/profile"), false);
  assert.equal(isRepoUrl("https://github.com/search?q=llm"), false);
  assert.equal(isRepoUrl("https://github.com/explore"), false);
  assert.equal(isRepoUrl("https://github.com/orgs/openai"), false);
  assert.equal(isRepoUrl("https://github.com/trending/python"), false);
});

test("contractForRuleBuild reads frozen snapshot contract only", () => {
  assert.deepEqual(contractForRuleBuild(undefined), {
    requiresEvidence: [],
    evidenceAny: [],
  });
  assert.deepEqual(
    contractForRuleBuild({
      requiresEvidence: ["page_author"],
      evidenceAny: [["repo_link"], ["official_domain"]],
      declared: true,
    }),
    {
      requiresEvidence: ["page_author"],
      evidenceAny: [["repo_link"], ["official_domain"]],
    },
  );
});

test("isTokenSatisfied: summary vs title_fallback", () => {
  const titleOnly = buildObservedEvidence({
    title: "Only a title",
    link: "https://example.com/a",
    summary: "Only a title",
    summarySource: "title_fallback",
    pubDate: "2026-09-24T00:00:00.000Z",
  });
  assert.equal(isTokenSatisfied("summary", titleOnly), false);
  assert.equal(isTokenSatisfied("summary_raw", titleOnly), true);
  assert.equal(isTokenSatisfied("title", titleOnly), true);

  const real = buildObservedEvidence({
    title: "T",
    link: "https://example.com/a",
    summary: "Real summary body",
    summarySource: "summary",
    pubDate: "2026-09-24T00:00:00.000Z",
  });
  assert.equal(isTokenSatisfied("summary", real), true);
});

test("normalizeEvidenceContract: empty snap vs empty live match; declared false stable", () => {
  const emptySnap = { requiresEvidence: [], evidenceAny: [], declared: false };
  const emptyLive = { requiresEvidence: [], evidenceAny: [], declared: false };
  assert.equal(normalizeEvidenceContract(emptySnap), normalizeEvidenceContract(emptyLive));
  const declaredTrue = { requiresEvidence: ["title"], evidenceAny: [], declared: true };
  assert.notEqual(normalizeEvidenceContract(emptySnap), normalizeEvidenceContract(declaredTrue));
});

test("rulesFingerprint changes when evidence engine version changes", async () => {
  const { rulesFingerprint, EVIDENCE_ENGINE_VERSION } = await import("../lib/fingerprint.mjs");
  const base = {
    items: [{ id: "1-1", group: "1", category: "model-releases", body: "x" }],
    promptBody: "p",
    model: "m",
    rulesContext: "c",
  };
  assert.notEqual(
    rulesFingerprint(base),
    rulesFingerprint({ ...base, evidenceEngineVersion: `${EVIDENCE_ENGINE_VERSION}-next` }),
  );
});

test("normalizeEvidenceContract is order-insensitive and detects changes", () => {
  const a = { requiresEvidence: ["page_author", "page_content"], evidenceAny: [["repo_link"]] };
  const b = { requiresEvidence: ["page_content", "page_author"], evidenceAny: [["repo_link"]] };
  assert.equal(normalizeEvidenceContract(a), normalizeEvidenceContract(b));
  const changed = { requiresEvidence: ["page_author"], evidenceAny: [["official_domain"]] };
  assert.notEqual(normalizeEvidenceContract(a), normalizeEvidenceContract(changed));
});


test("isTokenSatisfied: repo_link vs generic link; page facts never from RSS", () => {
  assert.equal(isTokenSatisfied("repo_link", observedRepo), true);
  assert.equal(isTokenSatisfied("repo_link", observedNews), false);
  assert.equal(isTokenSatisfied("repo_link", observedFull), false);
  assert.equal(isTokenSatisfied("link", observedNews), true);
  assert.equal(isTokenSatisfied("official_domain", observedFull), false);
  assert.equal(isTokenSatisfied("page_author", observedFull), false);
  assert.equal(isTokenSatisfied("title", observedFull), true);
});

test("parseEvidenceAny splits branches on semicolon", () => {
  assert.deepEqual(parseEvidenceAny("repo_link; official_domain"), [
    ["repo_link"],
    ["official_domain"],
  ]);
});

test("parseEvidenceContractSection reads proposal body", () => {
  const body = [
    "## Evidence Contract",
    "",
    "evidence_any: repo_link; official_domain",
    "requires_evidence: page_content",
  ].join("\n");
  const c = parseEvidenceContractSection(body);
  assert.deepEqual(c.requiresEvidence, ["page_content"]);
  assert.deepEqual(c.evidenceAny, [["repo_link"], ["official_domain"]]);
  assert.equal(c.empty, false);

  const empty = parseEvidenceContractSection("## Evidence Contract\n\n<!-- comments only -->\n");
  assert.equal(empty.empty, true);

  const bad = parseEvidenceContractSection("## Evidence Contract\n\nevidence_any: magic\n");
  assert.deepEqual(bad.invalidTokens, ["magic"]);
  assert.equal(bad.ok, false);

  const typo = parseEvidenceContractSection(
    "## Evidence Contract\n\nevidence_any: title\nrequires_evidnce: page_author\n",
  );
  assert.equal(typo.ok, false);
  assert.ok((typo.unknownKeys || []).length > 0 || (typo.errors || []).length > 0);

  const dup = parseEvidenceContractSection(
    "## Evidence Contract\n\nevidence_any: title\nevidence_any: summary\n",
  );
  assert.equal(dup.ok, false);
  assert.ok(dup.duplicateKeys.includes("evidence_any"));
});

test("ruleEvidenceContract reads requires_evidence and evidence_any", () => {
  const c = ruleEvidenceContract({
    requiresEvidence: ["page_content"],
    evidenceAny: [["repo_link"], ["official_domain"]],
  });
  assert.deepEqual(c.all, ["page_content"]);
  assert.deepEqual(c.any, [["repo_link"], ["official_domain"]]);
});

test("satisfiesEvidenceContract is branch-aware (OR)", () => {
  const contract5 = { all: [], any: [["repo_link"], ["official_domain"]] };
  assert.equal(satisfiesEvidenceContract(contract5, observedNews).ok, false);
  assert.equal(satisfiesEvidenceContract(contract5, observedRepo).ok, true);

  const contract1 = { all: [], any: [["official_domain"], ["page_author"]] };
  const miss = satisfiesEvidenceContract(contract1, observedFull);
  assert.equal(miss.ok, false);
  assert.match(miss.failedBranch, /official_domain/);
});

test("enforceEvidence allows 5-1 when a real repo link is observed", () => {
  const rule5 = {
    id: "5-1",
    body: "with a link to the repository or official announcement",
    evidenceAny: [["repo_link"], ["official_domain"]],
    requiresEvidence: [],
  };
  const out = enforceEvidence(okInclude, observedRepo, rule5);
  assert.equal(out.include, true, out.reason);
});

test("enforceEvidence denies 5-1 for ordinary news URL (no repo_link)", () => {
  const rule5 = {
    id: "5-1",
    body: "with a link to the repository or official announcement",
    evidenceAny: [["repo_link"], ["official_domain"]],
    requiresEvidence: [],
  };
  const out = enforceEvidence(
    { ...okInclude, evidenceCitations: ["title", "summary"] },
    observedNews,
    rule5,
  );
  assert.equal(out.include, false);
  assert.match(out.reason, /evidence contract unmet/);
});

test("enforceEvidence still denies page-fact-only 1-1 contract under RSS", () => {
  const rule1 = {
    id: "1-1",
    body: "official announcement page or a news article with a named author",
    evidenceAny: [["official_domain"], ["page_author"]],
    requiresEvidence: [],
  };
  const out = enforceEvidence(
    { ...okInclude, matchedRuleId: "1-1", categoryId: "model-releases", evidenceCitations: ["title", "summary"] },
    observedFull,
    rule1,
  );
  assert.equal(out.include, false);
  assert.equal(out.evidenceStatus, "needs_verification");
  assert.match(out.reason, /evidence contract unmet/);
});

test("enforceEvidence allows 1-1 via the RSS-observable link branch", () => {
  const rule1 = {
    id: "1-1",
    body: "official announcement page or a news article with a named author",
    evidenceAny: [["link"], ["official_domain"], ["page_author"]],
    requiresEvidence: [],
  };
  const out = enforceEvidence(
    { ...okInclude, matchedRuleId: "1-1", categoryId: "model-releases", evidenceCitations: ["title", "link"] },
    observedFull,
    rule1,
  );
  assert.equal(out.include, true, out.reason);
});

test("enforceEvidence requires_evidence is conjunctive", () => {
  const rule = {
    id: "x-1",
    body: "must have author and page body",
    requiresEvidence: ["page_author", "page_content"],
    evidenceAny: [],
  };
  const out = enforceEvidence(okInclude, observedFull, rule);
  assert.equal(out.include, false);
  assert.match(out.reason, /missing page_author|missing page_content/);
});

test("enforceEvidence body keywords alone do not veto", () => {
  const rule = {
    id: "5-1",
    body: "link to the repository or official announcement",
    requiresEvidence: [],
    evidenceAny: [],
  };
  const out = enforceEvidence(okInclude, observedRepo, rule);
  assert.equal(out.include, true, out.reason);
});

test("enforceEvidence default-denies without sufficient + citations", () => {
  const forced = enforceEvidence(
    {
      include: true,
      matchedRuleId: "2-1",
      categoryId: "research",
      reason: "looks good",
      evidenceCitations: ["title"],
    },
    observedFull,
    { id: "2-1", body: "papers", requiresEvidence: [], evidenceAny: [] },
  );
  assert.equal(forced.include, false);
  assert.match(forced.reason, /evidence insufficient/);

  const noCites = enforceEvidence(
    {
      include: true,
      matchedRuleId: "2-1",
      categoryId: "research",
      evidenceStatus: "sufficient",
      evidenceCitations: [],
      reason: "trust me",
    },
    observedFull,
    { id: "2-1", body: "papers" },
  );
  assert.equal(noCites.include, false);
  assert.match(noCites.reason, /without citations/);
});

test("enforceEvidence allows whitelisted non-title citations when the contract holds", () => {
  // Platform must not invent a content-citation veto beyond the ratified contract.
  const rule = {
    id: "x-1",
    body: "items whose link is present",
    requiresEvidence: ["link"],
    evidenceAny: [],
  };
  const out = enforceEvidence(
    {
      include: true,
      matchedRuleId: "x-1",
      categoryId: "industry",
      evidenceStatus: "sufficient",
      evidenceCitations: ["link", "sourceName"],
      reason: "contract satisfied by link",
    },
    observedNews,
    rule,
  );
  assert.equal(out.include, true, out.reason);
});

test("contractHasRssPath rejects page-fact-only contracts", () => {
  assert.equal(
    contractHasRssPath({ requiresEvidence: [], evidenceAny: [["official_domain"], ["page_author"]] }),
    false,
  );
  assert.equal(
    contractHasRssPath({ requiresEvidence: ["page_author"], evidenceAny: [] }),
    false,
  );
  assert.equal(
    contractHasRssPath({ requiresEvidence: [], evidenceAny: [["link"], ["official_domain"]] }),
    true,
  );
  assert.equal(
    contractHasRssPath({ requiresEvidence: ["title"], evidenceAny: [["link"]] }),
    true,
  );
  assert.equal(
    contractHasRssPath({ requiresEvidence: ["repo_link"], evidenceAny: [] }),
    true,
  );
});

test("isRssObservableToken distinguishes page-fact tokens", () => {
  assert.equal(isRssObservableToken("link"), true);
  assert.equal(isRssObservableToken("repo_link"), true);
  assert.equal(isRssObservableToken("official_domain"), false);
  assert.equal(isRssObservableToken("page_author"), false);
  assert.equal(isRssObservableToken("nope"), false);
});

test("parseEvidenceContractSection strips multi-line HTML comments", () => {
  const body = `## Evidence Contract

<!--
guidance line one
guidance line two
-->
evidence_any: title; summary
`;
  const parsed = parseEvidenceContractSection(body);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.evidenceAny, [["title"], ["summary"]]);
  assert.equal(parsed.unknownKeys.length, 0);
});

test("parseEvidenceContractSection ignores commented heading and accepts case variants", () => {
  // A comment that names the section must not hijack the real contract.
  const hijack = `<!-- ## Evidence Contract
requires_evidence: page_author
-->
## Evidence Contract

evidence_any: title; summary
`;
  const parsed = parseEvidenceContractSection(hijack);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.evidenceAny, [["title"], ["summary"]]);
  assert.deepEqual(parsed.requiresEvidence, []);

  const lower = parseEvidenceContractSection("## evidence contract\n\nevidence_any: link\n");
  assert.equal(lower.ok, true, JSON.stringify(lower));
  assert.deepEqual(lower.evidenceAny, [["link"]]);
});
