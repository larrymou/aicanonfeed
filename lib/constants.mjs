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

/** Star thresholds for cold-start quorum stages. Quorum never drops below MIN_QUORUM. */
export const MIN_QUORUM = 3;
/** F1 cold-start founder casting vote (while stars < ceiling). */
export const FOUNDER_LOGIN = "larrymou";
export const FOUNDER_STAR_CEILING = 100;
export const COLD_START = [
  { stage: "S0", maxStars: 199, quorum: 3 },
  { stage: "S1", maxStars: 999, quorum: 5 },
  {
    stage: "S2",
    maxStars: Infinity,
    quorum: (stars) => Math.max(MIN_QUORUM, Math.floor(stars / 100) + 1),
  },
];

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

export function stageForStars(stars) {
  const n = Number(stars) || 0;
  for (const s of COLD_START) {
    if (n <= s.maxStars) {
      const raw = typeof s.quorum === "function" ? s.quorum(n) : s.quorum;
      return { stage: s.stage, stars: n, quorum: Math.max(MIN_QUORUM, raw) };
    }
  }
  const last = COLD_START[COLD_START.length - 1];
  const raw =
    typeof last.quorum === "function" ? last.quorum(n) : last.quorum;
  return {
    stage: last.stage,
    stars: n,
    quorum: Math.max(MIN_QUORUM, raw),
  };
}
