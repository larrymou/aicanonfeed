/**
 * Stable identity for a settlement comment.
 * Must NOT include `settledAt` — recover rewrites that timestamp on every
 * retry and would mint a new marker (duplicate comments). Vote deadline +
 * outcome + PR pin the public message instead.
 */
export function settlementCommentIdentity(settlement) {
  const outcome = settlement?.outcome || "unknown";
  const voteOutcome = settlement?.voteOutcome || "";
  const deadline = settlement?.voteDeadlineAt || "legacy";
  const pr = settlement?.prNumber ?? "";
  return `${outcome}|${voteOutcome}|${deadline}|${pr}`;
}

export function settlementCommentMarker(issueNumber, settlement, kind = "settlement") {
  return `<!-- aicanonfeed-settlement:${issueNumber}:${encodeURIComponent(settlementCommentIdentity(settlement))}:${kind} -->`;
}
