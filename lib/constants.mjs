/** Hard constants — cannot be changed by community proposals (M5). */

export const CATEGORIES = {
  "model-releases": "Model Releases",
  research: "Research",
  industry: "Industry",
  policy: "Policy",
  "tools-oss": "Tools & OSS",
};

export const LABELS = {
  proposal: "proposal",
  voting: "voting",
  rejected: "rejected",
  ratified: "ratified",
  pendingMerge: "ratified_pending_merge",
  defeated: "defeated",
  expired: "expired_no_quorum",
  doNotMerge: "do-not-merge",
};

/** Stage labels are display-only. Quorum uses the unified formula; auto-merge uses AUTO_MERGE_MIN_STARS. */
export const MIN_QUORUM = 3;
export const QUORUM_MAX = 25;
/** Rule PRs are auto-merged only at or above this star count (human merge below). */
export const AUTO_MERGE_MIN_STARS = 200;
/** Votes only count if the account is at least this old (sockpuppet gate; required before auto-merge). */
export const MIN_ACCOUNT_AGE_DAYS = 30;
/** F1 cold-start founder casting vote (while stars < ceiling). Aligned with AUTO_MERGE_MIN_STARS. */
export const FOUNDER_LOGIN = "larrymou";
export const FOUNDER_STAR_CEILING = 200;
/**
 * Proposal filing quota (seriousness gate). Founder is unlimited while stars < FOUNDER_STAR_CEILING
 * (same star gate as F1). Everyone else: one open proposal at a time + one new proposal per UTC day.
 */
export const PROPOSAL_OPEN_LIMIT = 1;
export const PROPOSAL_DAILY_LIMIT = 1;

/**
 * Unified quorum formula (stars as electorate proxy — simple, public, gameable;
 * accepted for this experiment). Floor 3, steep log2 growth, cap 25.
 * Formula: min(25, max(3, floor(2 * log2(stars + 1)) - 7))
 * - 0★ → 3, 100★ → 6, 1k★ → 12, 10k★ → 19, ~65k★ → 25 (cap)
 * Community proposals cannot change this (M5); maintainers change code only.
 */
export function quorumForStars(stars) {
  const n = Math.max(0, Number(stars) || 0);
  const raw = Math.floor(Math.log2(n + 1) * 2) - 7;
  return Math.min(QUORUM_MAX, Math.max(MIN_QUORUM, raw));
}

export function stageForStars(stars) {
  const n = Math.max(0, Number(stars) || 0);
  const stage = n < 200 ? "S0" : n < 1000 ? "S1" : "S2";
  return { stage, stars: n, quorum: quorumForStars(n) };
}

/** Auto-merge is a pure star gate — independent of display stage labels. */
export function canAutoMerge(stars) {
  return Math.max(0, Number(stars) || 0) >= AUTO_MERGE_MIN_STARS;
}

export const RULE_ID_RE = /^\d+-\d+$/;
export const RULE_MAX_CHARS = 1500;
export const RULE_MAX_CHARS_GROUP = 500;
export const FEED_MAX_NEW_PER_RUN = 30;
export const SUMMARY_MAX_CHARS = 280;
/** Only ingest news published within this window (days). Avoids ancient RSS backlog. */
export const CONTENT_MAX_AGE_DAYS = 5;

/**
 * Ingest balance (not ranking): keep Research from flooding the mixed feed.
 * - Default per-source cap when feeds.json has no maxPerRun
 * - Hard share of a single run reserved for research (rest filled by non-research)
 */
export const DEFAULT_SOURCE_MAX_PER_RUN = 12;
export const RESEARCH_RUN_SHARE_MAX = 0.5;
/**
 * Display caps — editorial balance for the shared 5-day window.
 * Research is capped harder so arXiv volume cannot own the front page.
 */
export const PAGE_MAX_PER_CATEGORY = 25;
export const PAGE_MAX_RESEARCH = 10;

/** Display order for the tab rail. */
export const TAB_ORDER = [
  "all",
  "model-releases",
  "industry",
  "research",
  "tools-oss",
  "policy",
];

export function isResearchCategory(cat) {
  return cat === "research";
}

/** Only these slugs may appear as categoryId / CSS class / tab filter. */
export function isCategory(id) {
  return Object.prototype.hasOwnProperty.call(CATEGORIES, id);
}

/** Parse `<group>-<item>` ID. Returns { group, item } or null. */
export function parseRuleId(id) {
  const m = String(id || "").match(/^(\d+)-(\d+)$/);
  return m ? { group: Number(m[1]), item: Number(m[2]) } : null;
}

/** True if ID refers to a group definition (item === 0). */
export function isGroupRule(id) {
  const p = parseRuleId(id);
  return p !== null && p.item === 0;
}

