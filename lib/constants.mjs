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
  defeated: "defeated",
  expired: "expired_no_quorum",
  doNotMerge: "do-not-merge",
};

/** Star thresholds for cold-start quorum stages. */
export const COLD_START = [
  { stage: "S0", maxStars: 199, quorum: 1 },
  { stage: "S1", maxStars: 999, quorum: 5 },
  {
    stage: "S2",
    maxStars: Infinity,
    quorum: (stars) => Math.floor(stars / 100) + 1,
  },
];

export const RULE_ID_RE = /^R\d+$/;
export const RULE_MAX_CHARS = 800;
export const FEED_MAX_NEW_PER_RUN = 30;
export const SUMMARY_MAX_CHARS = 280;
/** Only ingest news published within this window (days). Avoids ancient RSS backlog. */
export const CONTENT_MAX_AGE_DAYS = 14;

/**
 * Ingest balance (not ranking): keep Research from flooding the mixed feed.
 * - Default per-source cap when feeds.json has no maxPerRun
 * - Soft share of a single run reserved for non-research first
 */
export const DEFAULT_SOURCE_MAX_PER_RUN = 12;
export const RESEARCH_RUN_SHARE_MAX = 0.5;

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

export function stageForStars(stars) {
  const n = Number(stars) || 0;
  for (const s of COLD_START) {
    if (n <= s.maxStars) {
      const quorum = typeof s.quorum === "function" ? s.quorum(n) : s.quorum;
      return { stage: s.stage, stars: n, quorum };
    }
  }
  const last = COLD_START[COLD_START.length - 1];
  return {
    stage: last.stage,
    stars: n,
    quorum: typeof last.quorum === "function" ? last.quorum(n) : last.quorum,
  };
}
