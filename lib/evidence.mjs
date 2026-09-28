/**
 * Evidence discipline for content moderation.
 *
 * Pipeline RSS fields are the only observed facts unless a fetcher adds more.
 * Rule evidence metadata is branch-aware:
 * - requires_evidence: ALL tokens must be satisfied (conjunctive)
 * - evidence_any: any ONE branch (comma-separated tokens) may satisfy (disjunctive)
 * Body keywords are NOT used to veto — rules must declare their own branches.
 */

export const NOT_OBSERVED_FROM_RSS = [
  "linked_page_content",
  "linked_page_author",
  "linked_page_owner_domain",
  "announcement_page_version_label",
];

/** Re-export so governance can pin adjudicator semantics in records. */
export { EVIDENCE_ENGINE_VERSION } from "./fingerprint.mjs";

/** requires_evidence / evidence_any token → page-level fact (unobserved from RSS). */
export const REQUIRES_TOKEN_TO_FACT = {
  official_domain: "linked_page_owner_domain",
  page_author: "linked_page_author",
  page_content: "linked_page_content",
  page_version_label: "announcement_page_version_label",
};

const ALLOWED_STATUS = new Set(["sufficient", "insufficient", "needs_verification"]);

/** Tolerance for slightly-future RSS timestamps (clock skew / embargo). */
export const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Field names a verdict may cite. Others are rejected as unobserved. */
export const OBSERVED_FIELD_NAMES = new Set([
  "title",
  "summary",
  "summary_raw",
  "link",
  "linkHost",
  "pubDate",
  "sourceName",
  "linked_page_owner_domain",
  "linked_page_author",
]);

/**
 * Parse `## Evidence Contract` from a proposal body.
 * Accepts lines:
 *   requires_evidence: a, b
 *   evidence_any: branch1; branch2
 * @returns {{ requiresEvidence: string[], evidenceAny: string[][], ok: boolean, invalidTokens: string[] }}
 */
export function parseEvidenceContractSection(body) {
  // Strip HTML comments before matching the heading — a comment that mentions
  // `## Evidence Contract` must not hijack the real section. Heading is
  // case-insensitive like the other body parsers.
  const raw = String(body || "").replace(/<!--[\s\S]*?-->/g, "");
  const m = raw.match(/(^|\n)##[ \t]*Evidence Contract[ \t]*\r?\n([\s\S]*?)(?=\n##[ \t]|$)/i);
  const section = m ? String(m[2]) : "";
  const requiresEvidence = [];
  const evidenceAny = [];
  const invalidTokens = [];
  const unknownKeys = [];
  const duplicateKeys = [];
  const seenKeys = new Set();
  for (const line of section.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const req = t.match(/^requires_evidence\s*:\s*(.+)$/i);
    if (req) {
      if (seenKeys.has("requires_evidence")) duplicateKeys.push("requires_evidence");
      seenKeys.add("requires_evidence");
      const list = parseTokenList(req[1]);
      if (!list.length) unknownKeys.push("(empty requires_evidence)");
      for (const tok of list) {
        if (!EVIDENCE_TOKENS.has(tok)) invalidTokens.push(tok);
        else requiresEvidence.push(tok);
      }
      continue;
    }
    const any = t.match(/^evidence_any\s*:\s*(.+)$/i);
    if (any) {
      if (seenKeys.has("evidence_any")) duplicateKeys.push("evidence_any");
      seenKeys.add("evidence_any");
      const branches = parseEvidenceAny(any[1]);
      if (!branches.length) unknownKeys.push("(empty evidence_any)");
      for (const branch of branches) {
        for (const tok of branch) {
          if (!EVIDENCE_TOKENS.has(tok)) invalidTokens.push(tok);
        }
        if (branch.every((tok) => EVIDENCE_TOKENS.has(tok))) evidenceAny.push(branch);
      }
      continue;
    }
    // Strict: every other non-comment line is a typo / unknown key.
    unknownKeys.push(t.split(":")[0].trim() || t);
  }
  const uniq = [...new Set(requiresEvidence)];
  const errors = [
    ...invalidTokens.map((t) => `invalid_token:${t}`),
    ...unknownKeys.map((t) => `unknown_key:${t}`),
    ...duplicateKeys.map((t) => `duplicate_key:${t}`),
  ];
  return {
    requiresEvidence: uniq,
    evidenceAny,
    ok: errors.length === 0 && (uniq.length > 0 || evidenceAny.length > 0),
    hasSection: Boolean(m),
    invalidTokens: [...new Set(invalidTokens)],
    unknownKeys: [...new Set(unknownKeys)],
    duplicateKeys: [...new Set(duplicateKeys)],
    errors,
    empty: uniq.length === 0 && evidenceAny.length === 0,
  };
}

/** Whether one evidence token can be satisfied from the observed RSS payload. */
export function isTokenSatisfied(token, observed) {
  const t = String(token || "").trim();
  if (!t) return false;
  switch (t) {
    case "repo_link":
      return isRepoUrl(observed?.link);
    case "code_host_link":
      return isRepoUrl(observed?.link);
    case "link":
      return Boolean(observed?.link);
    case "linkHost":
      return Boolean(observed?.linkHost);
    case "title":
      return Boolean(observed?.titlePresent);
    case "summary":
      return Boolean(observed?.summary) && observed?.summarySource !== "title_fallback";
    case "summary_raw":
      return Boolean(observed?.summary);
    case "pubDate":
      return Boolean(observed?.pubDate);
    case "sourceName":
      return Boolean(observed?.sourceName);
    default: {
      // Page-fact tokens (official_domain, page_author, …). A populated fact
      // field is observed — same rule as citationIsObserved. `notObserved` is
      // informational (classifyCitation); it must not override a present field.
      const fact = REQUIRES_TOKEN_TO_FACT[t] || t;
      return Boolean(observed?.[fact]);
    }
  }
}

/** Tokens allowed in requires_evidence / evidence_any. */
export const EVIDENCE_TOKENS = new Set([
  "repo_link",
  "code_host_link",
  "link",
  "linkHost",
  "title",
  "summary",
  "summary_raw",
  "pubDate",
  "sourceName",
  "official_domain",
  "page_author",
  "page_content",
  "page_version_label",
]);

/** Page-fact tokens: only observable after a linked-page fetcher exists. */
export const PAGE_FACT_TOKENS = new Set(Object.keys(REQUIRES_TOKEN_TO_FACT));

/** True when the pipeline can satisfy this token from RSS fields alone. */
export function isRssObservableToken(token) {
  const t = String(token || "").trim();
  return EVIDENCE_TOKENS.has(t) && !PAGE_FACT_TOKENS.has(t);
}

/**
 * True when a contract mentions any page-fact token (a linked-page fetch may
 * help). Does not change enforcement — only steers whether the pipeline fetches.
 */
export function contractNeedsPageFacts(contract) {
  const all = (contract?.requiresEvidence || contract?.all || []).map((t) =>
    String(t || "").trim(),
  );
  const any = (contract?.evidenceAny || contract?.any || []).flat().map((t) =>
    String(t || "").trim(),
  );
  return [...all, ...any].some((t) => PAGE_FACT_TOKENS.has(t));
}

/**
 * True when at least one contract path is satisfiable from RSS today.
 * - requires_evidence must not contain page-fact tokens (ALL would hard-deny)
 * - if evidence_any is declared, at least one branch must be fully RSS-observable
 */
export function contractHasRssPath(contract) {
  const all = (contract?.requiresEvidence || contract?.all || []).map((t) =>
    String(t || "").trim(),
  );
  if (all.some((t) => t && !isRssObservableToken(t))) return false;
  const any = contract?.evidenceAny || contract?.any || [];
  if (!any.length) return all.every((t) => isRssObservableToken(t));
  return any.some((branch) => {
    const tokens = (Array.isArray(branch) ? branch : [branch])
      .map((t) => String(t || "").trim())
      .filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => isRssObservableToken(t));
  });
}

/** Known code-hosting hosts (owner/repo path required). */
export const CODE_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "gitee.com",
  "sourceforge.net",
  "sr.ht",
  "git.sr.ht",
  "huggingface.co",
]);

/** Non-repo first path segments on code hosts (profiles, topics, settings, …). */
export const CODE_HOST_NON_REPO_SEGMENTS = new Set([
  "topics",
  "trending",
  "collections",
  "events",
  "explore",
  "features",
  "pricing",
  "about",
  "blog",
  "docs",
  "help",
  "support",
  "search",
  "settings",
  "login",
  "logout",
  "signup",
  "join",
  "orgs",
  "users",
  "marketplace",
  "sponsors",
  "codespaces",
  "notifications",
  "pulls",
  "issues",
  "new",
  "dashboard",
  "account",
  "session",
  "profile",
  "sessions",
  "apps",
  "customer-stories",
  "readme",
  "security",
  "premium-support",
  "enterprise",
  "team",
  "contact",
  "site",
  "hero",
  "open-source",
]);

/**
 * True when the URL looks like a source repository, not a generic article.
 * - known code host + owner/repo path (first segment not a site page)
 * - or any host whose path ends in `.git`
 */
export function isRepoUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    if (/\.git$/i.test(u.pathname)) {
      return parts.length >= 1;
    }
    if (CODE_HOSTS.has(host) || host === "git.sr.ht") {
      if (parts.length < 2) return false;
      const first = parts[0].toLowerCase();
      if (CODE_HOST_NON_REPO_SEGMENTS.has(first)) return false;
      // owner and repo must look like path segments (allow ~ for sourcehut)
      if (!/^[\w.~-]+$/.test(parts[0]) || !/^[\w.~-]+$/.test(parts[1])) return false;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Facts present in the pipeline payload, plus optional linked-page facts.
 * @param {object} item RSS candidate
 * @param {object|null} [pageFacts] from fetchPageFacts / parsePageFacts (host + author only)
 */
export function buildObservedEvidence(item, pageFacts = null) {
  const link = String(item.link || "");
  let linkHost = null;
  try {
    linkHost = new URL(link).hostname;
  } catch {
    linkHost = null;
  }
  const summary = item.summary == null ? null : String(item.summary);
  const observed = {
    titlePresent: Boolean(String(item.title || "").trim()),
    summary,
    summaryChars: summary ? summary.length : 0,
    summarySource: item.summarySource || (summary ? "summary" : null),
    link,
    linkHost,
    pubDate: item.pubDate || null,
    sourceName: item.sourceName || null,
    notObserved: [...NOT_OBSERVED_FROM_RSS],
  };

  if (pageFacts?.ok) {
    if (pageFacts.ownerDomain) {
      observed.linked_page_owner_domain = String(pageFacts.ownerDomain);
      dropNotObserved(observed, "linked_page_owner_domain");
    }
    if (pageFacts.author) {
      observed.linked_page_author = String(pageFacts.author).slice(0, 120);
      dropNotObserved(observed, "linked_page_author");
    }
  }
  return observed;
}

function dropNotObserved(observed, fact) {
  observed.notObserved = (observed.notObserved || []).filter((f) => f !== fact);
}

function parseTokenList(value) {
  if (Array.isArray(value)) {
    return value.map((t) => String(t).trim()).filter(Boolean);
  }
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Parse `evidence_any: repo_link; official_domain` into [["repo_link"],["official_domain"]]. */
export function parseEvidenceAny(value) {
  if (Array.isArray(value)) {
    return value
      .map((branch) => (Array.isArray(branch) ? branch.map((t) => String(t).trim()).filter(Boolean) : parseTokenList(branch)))
      .filter((b) => b.length);
  }
  if (!value) return [];
  return String(value)
    .split(";")
    .map((part) => parseTokenList(part))
    .filter((b) => b.length);
}

/**
 * Evidence branches the rule requires. Explicit frontmatter only.
 * @returns {{ all: string[], any: string[][] }}
 */
export function ruleEvidenceContract(rule) {
  if (!rule) return { all: [], any: [] };
  const all = parseTokenList(rule.requiresEvidence ?? rule.requires_evidence);
  const any = parseEvidenceAny(rule.evidenceAny ?? rule.evidence_any);
  return { all, any };
}

/** Canonical JSON of an evidence contract (for snapshot-vs-live comparison). */
export function normalizeEvidenceContract(contract) {
  const all = [...(contract?.requiresEvidence || contract?.all || [])]
    .map((t) => String(t).trim())
    .filter(Boolean)
    .sort();
  const any = (contract?.evidenceAny || contract?.any || [])
    .map((branch) =>
      (Array.isArray(branch) ? branch : [branch])
        .map((t) => String(t).trim())
        .filter(Boolean)
        .sort()
        .join("+"),
    )
    .sort()
    .join(";");
  const declared =
    contract?.declared != null
      ? Boolean(contract.declared)
      : all.length > 0 || any.length > 0;
  return JSON.stringify({ all, any, declared });
}

/**
 * Contract fields to pass into buildRuleFile from a frozen snapshot
 * (settlePhase must not reference preReviewPhase locals).
 */
export function contractForRuleBuild(snapshotEvidenceContract) {
  const c = snapshotEvidenceContract || {};
  return {
    requiresEvidence: Array.isArray(c.requiresEvidence) ? c.requiresEvidence : [],
    evidenceAny: Array.isArray(c.evidenceAny) ? c.evidenceAny : [],
  };
}

/**
 * Can the rule's evidence contract be met from observed fields?
 * - every `all` token must be satisfied
 * - if `any` is non-empty, at least one branch must be fully satisfied
 */
export function satisfiesEvidenceContract(contract, observed) {
  const { all, any } = contract || { all: [], any: [] };
  for (const t of all) {
    if (!isTokenSatisfied(t, observed)) {
      return { ok: false, missing: [t], failedBranch: null };
    }
  }
  if (!any.length) return { ok: true, missing: [], failedBranch: null };
  for (const branch of any) {
    if (branch.every((t) => isTokenSatisfied(t, observed))) {
      return { ok: true, missing: [], failedBranch: null };
    }
  }
  return {
    ok: false,
    missing: [],
    failedBranch: any.map((b) => b.join("+")).join(" | "),
  };
}

/** Rule token / legacy camelCase names that models may cite; map to field names. */
const CITATION_ALIASES = {
  official_domain: "linked_page_owner_domain",
  page_author: "linked_page_author",
  page_content: "linked_page_content",
  page_version_label: "announcement_page_version_label",
  linkedPageOwnerDomain: "linked_page_owner_domain",
  linkedPageAuthor: "linked_page_author",
};

function citationFieldKey(citation) {
  const raw = String(citation || "").trim();
  return Object.hasOwn(CITATION_ALIASES, raw) ? CITATION_ALIASES[raw] : raw;
}

function citationIsObserved(citation, observed) {
  const raw = String(citation || "").trim();
  // Contract tokens that assert a property of `link` — only when that holds.
  if (raw === "repo_link" || raw === "code_host_link") {
    return isRepoUrl(observed?.link);
  }
  const key = citationFieldKey(raw);
  if (!OBSERVED_FIELD_NAMES.has(key)) return false;
  switch (key) {
    case "title":
      return Boolean(observed?.titlePresent);
    case "summary":
      // Title-fallback "summary" does not satisfy the summary token.
      return Boolean(observed?.summary) && observed?.summarySource !== "title_fallback";
    case "summary_raw":
      return Boolean(observed?.summary);
    case "link":
      return Boolean(observed?.link);
    case "linkHost":
      return Boolean(observed?.linkHost);
    case "pubDate":
      return Boolean(observed?.pubDate);
    case "sourceName":
      return Boolean(observed?.sourceName);
    case "linked_page_owner_domain":
      return Boolean(observed?.linked_page_owner_domain);
    case "linked_page_author":
      return Boolean(observed?.linked_page_author);
    default:
      return false;
  }
}

/**
 * Citation classes:
 * - observed: fact holds and is citable
 * - unobserved_page_fact: page-fact name that is explicitly not observed (fetch
 *   missed or never ran). Not a fatal protocol error — the platform only offers
 *   those fields "when present"; the contract gate still hard-enforces them.
 * - invalid: unknown name, or a name whose fact does not hold (e.g. repo_link
 *   on a non-repo URL, summary on title_fallback)
 */
function classifyCitation(citation, observed) {
  const raw = String(citation || "").trim();
  if (citationIsObserved(raw, observed)) return "observed";
  // repo_link / code_host_link claim a property of link; false claim is invalid.
  if (raw === "repo_link" || raw === "code_host_link") return "invalid";
  const key = citationFieldKey(raw);
  const notObs = observed?.notObserved || NOT_OBSERVED_FROM_RSS;
  const fact = REQUIRES_TOKEN_TO_FACT[raw] || REQUIRES_TOKEN_TO_FACT[key] || key;
  if (PAGE_FACT_TOKENS.has(raw) || notObs.includes(fact) || notObs.includes(key)) {
    return "unobserved_page_fact";
  }
  return "invalid";
}

function forcedReject(result, citations, evidenceStatus, reason) {
  return {
    ...result,
    include: false,
    matchedRuleId: null,
    categoryId: null,
    evidenceStatus,
    evidenceCitations: citations,
    reason,
  };
}

/**
 * Default-deny at the program layer:
 * - include requires evidenceStatus === "sufficient"
 * - include requires the matched rule's evidence contract to be satisfiable
 *   (requires_evidence AND evidence_any), using only observed fields
 * - include requires at least one citation naming a populated observed field
 * - citations naming unobserved page facts are dropped (not fatal); unknown
 *   field names remain a forced reject
 *
 * @param {object} result model verdict
 * @param {object} observed from buildObservedEvidence
 * @param {object} rule matched rule (optional; enables contract gate)
 */
export function enforceEvidence(result, observed = null, rule = null) {
  const raw = result?.evidenceStatus;
  const evidenceStatus = ALLOWED_STATUS.has(raw) ? raw : "insufficient";
  // Keep only non-empty strings. Do not String(null) → "null". Dedupe, keep order.
  const citations = Array.isArray(result?.evidenceCitations)
    ? [...new Set(
        result.evidenceCitations
          .filter((c) => typeof c === "string")
          .map((c) => c.trim())
          .filter(Boolean),
      )]
    : [];

  if (result?.include !== true) {
    return { ...result, evidenceStatus, evidenceCitations: citations };
  }

  if (rule) {
    const contract = ruleEvidenceContract(rule);
    const sat = satisfiesEvidenceContract(contract, observed);
    if (!sat.ok) {
      const why = sat.missing.length
        ? `missing ${sat.missing.join(", ")}`
        : `no satisfiable branch (${sat.failedBranch})`;
      return forcedReject(
        result,
        citations,
        "needs_verification",
        `Forced reject: evidence contract unmet (${why})`,
      );
    }
  }

  if (evidenceStatus !== "sufficient") {
    return forcedReject(result, citations, evidenceStatus, `Forced reject: evidence ${evidenceStatus}`);
  }

  if (!citations.length) {
    return forcedReject(
      result,
      citations,
      "insufficient",
      "Forced reject: evidence sufficient without citations",
    );
  }

  if (observed) {
    const kept = [];
    for (const c of citations) {
      const kind = classifyCitation(c, observed);
      if (kind === "observed") {
        kept.push(c);
      } else if (kind === "invalid") {
        return forcedReject(
          result,
          citations,
          "insufficient",
          `Forced reject: citation not observed (${c})`,
        );
      }
      // unobserved_page_fact: drop; contract already enforced required tokens.
    }
    if (!kept.length) {
      return forcedReject(
        result,
        citations,
        "insufficient",
        "Forced reject: evidence sufficient without citations",
      );
    }
    return { ...result, evidenceStatus, evidenceCitations: kept };
  }

  return { ...result, evidenceStatus, evidenceCitations: citations };
}
