import { isResearchCategory } from "./constants.mjs";

/**
 * Unified research signal for share/quota: an item counts as research if the
 * source feed is research OR the matched rule category is research. Using only
 * one side lets a reclassified item slip past the research cap.
 */
export function countsAsResearch({ sourceCategory = null, categoryId = null } = {}) {
  return isResearchCategory(sourceCategory) || isResearchCategory(categoryId);
}

/** Limit research candidates to the configured share of the admitted run. */
export function researchCandidateCap({
  nonResearchCandidates,
  runLimit,
  share,
}) {
  const limit = Math.max(0, Math.floor(Number(runLimit) || 0));
  const fraction = Math.max(0, Math.min(1, Number(share) || 0));
  if (fraction === 0 || limit === 0) return 0;
  if (fraction === 1) return limit;
  const nonResearch = Math.max(0, Math.floor(Number(nonResearchCandidates) || 0));
  const runShareCap = Math.floor(limit * fraction);
  // With no non-research admits, the balance formula collapses to 0 and would
  // starve every research include. Fall back to the pure share cap instead.
  const balanceCap =
    nonResearch === 0
      ? runShareCap
      : Math.floor((nonResearch * fraction) / (1 - fraction));
  return Math.min(runShareCap, balanceCap);
}

export function researchAdmission({
  include,
  categoryId,
  sourceCategory = null,
  researchIncludedCount,
  maxResearch,
}) {
  if (!include || !countsAsResearch({ sourceCategory, categoryId })) {
    return { admitted: true, deferred: false, researchIncludedCount };
  }
  if (researchIncludedCount >= maxResearch) {
    return { admitted: false, deferred: true, researchIncludedCount };
  }
  return {
    admitted: true,
    deferred: false,
    researchIncludedCount: researchIncludedCount + 1,
  };
}

/** Normalize completed and interrupted run summaries for the public page. */
export function summarizeRunAudit(runAudit) {
  if (!runAudit) return null;
  const number = (...values) => {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return 0;
  };
  const decided = number(runAudit.decidedCount, runAudit.decided);
  const included = number(runAudit.includedCount, runAudit.included);
  const quotaDeferred = number(
    runAudit.quotaDeferredCount,
    runAudit.quotaDeferredResearchCount,
  );
  const pending = number(runAudit.pendingResearchCount);
  const errors = number(runAudit.errorCount, runAudit.errors);
  const hasModelReviewedCount =
    runAudit.modelReviewedCount !== undefined &&
    Number.isFinite(Number(runAudit.modelReviewedCount));
  return {
    decided,
    included,
    quotaDeferred,
    errors,
    modelReviewed: hasModelReviewedCount
      ? number(runAudit.modelReviewedCount)
      : decided + quotaDeferred + pending + errors,
    notReviewed: Array.isArray(runAudit.notReviewed)
      ? runAudit.notReviewed.length
      : number(runAudit.notReviewedCount),
    pending,
  };
}

function runTime(run) {
  const idTime = String(run?.runId || "").match(/^run-(\d+)-/);
  if (idTime) return Number(idTime[1]);
  for (const key of ["finishedAt", "abortedAt", "ranAt"]) {
    const value = Date.parse(String(run?.[key] || ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function terminalTime(run) {
  for (const key of ["abortedAt", "finishedAt", "ranAt"]) {
    const value = Date.parse(String(run?.[key] || ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** Select summaries by their run identity, not by their filename. */
export function latestRunAudit(records = []) {
  return [...records]
    .filter((record) => record && typeof record === "object")
    .sort((a, b) => {
      const runDiff = (runTime(b) ?? -1) - (runTime(a) ?? -1);
      return runDiff || (terminalTime(b) ?? -1) - (terminalTime(a) ?? -1);
    })[0] || null;
}

/** True only when an unpaired research journal belongs to a later run. */
export function researchJournalIsNewer(researchAudit, runAudit) {
  if (!researchAudit) return false;
  if (!runAudit) return true;
  if (researchAudit.runId === runAudit.runId) return false;
  const researchTime = runTime({ runId: researchAudit.runId });
  const summaryTime = runTime(runAudit);
  return researchTime !== null &&
    (summaryTime === null || researchTime > summaryTime);
}

/** Replay the latest state of each research decision from its event journal. */
export function summarizeResearchEvents(events = []) {
  const latestByHash = new Map();
  for (const event of events) {
    if (!event?.urlHash || !["pending", "admitted", "deferred"].includes(event.event)) {
      continue;
    }
    latestByHash.set(event.urlHash, event);
  }
  const states = [...latestByHash.values()];
  return {
    reviewed: states.length,
    pending: states.filter((event) => event.event === "pending").length,
    admitted: states.filter((event) => event.event === "admitted").length,
    deferred: states.filter((event) => event.event === "deferred").length,
  };
}
