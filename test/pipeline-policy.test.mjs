import test from "node:test";
import assert from "node:assert/strict";
import {
  countsAsResearch,
  researchAdmission,
  researchCandidateCap,
  latestRunAudit,
  researchJournalIsNewer,
  summarizeResearchEvents,
  summarizeRunAudit,
} from "../lib/pipeline-policy.mjs";

test("run audit summary counts model-reviewed research deferred by quota", () => {
  assert.deepEqual(
    summarizeRunAudit({
      decided: 5,
      included: 3,
      quotaDeferredResearchCount: 4,
      errors: 2,
      notReviewed: [{ urlHash: "a" }],
    }),
    {
      decided: 5,
      included: 3,
      quotaDeferred: 4,
      errors: 2,
      modelReviewed: 11,
      notReviewed: 1,
      pending: 0,
    },
  );
});

test("run audit summary includes pending research decisions after interruption", () => {
  assert.deepEqual(
    summarizeRunAudit({
      aborted: true,
      decidedCount: 2,
      quotaDeferredCount: 1,
      errorCount: 2,
      pendingResearchCount: 3,
    }),
    {
      decided: 2,
      included: 0,
      quotaDeferred: 1,
      errors: 2,
      modelReviewed: 8,
      notReviewed: 0,
      pending: 3,
    },
  );
});

test("run audit uses run identity rather than summary filename order", () => {
  const older = { runId: "run-1000-old", finishedAt: "2026-01-01T00:00:10Z" };
  const newer = { runId: "run-2000-new", aborted: true };
  assert.equal(latestRunAudit([newer, older]), newer);
  const completed = {
    runId: "run-3000-same",
    finishedAt: "2026-01-01T00:00:10Z",
  };
  const aborted = {
    runId: "run-3000-same",
    abortedAt: "2026-01-01T00:00:11Z",
    aborted: true,
  };
  assert.equal(latestRunAudit([completed, aborted]), aborted);
});

test("only a later research journal indicates an unpaired run", () => {
  const summary = { runId: "run-2000-current" };
  assert.equal(researchJournalIsNewer({ runId: "run-1000-old" }, summary), false);
  assert.equal(researchJournalIsNewer({ runId: "run-3000-new" }, summary), true);
  assert.equal(researchJournalIsNewer({ runId: "run-2000-current" }, summary), false);
});

test("run audit counts retryable model errors separately from decisions", () => {
  assert.deepEqual(
    summarizeRunAudit({ decidedCount: 1, errorCount: 2, modelReviewedCount: 3 }),
    {
      decided: 1,
      included: 0,
      quotaDeferred: 0,
      errors: 2,
      modelReviewed: 3,
      notReviewed: 0,
      pending: 0,
    },
  );
  assert.equal(
    summarizeRunAudit({
      decidedCount: 1,
      errors: 2,
      modelReviewed: 1,
    }).modelReviewed,
    3,
    "legacy summaries omitted errors from modelReviewed",
  );
});

test("research journal replay keeps the latest state for each item", () => {
  assert.deepEqual(
    summarizeResearchEvents([
      { urlHash: "a", event: "pending" },
      { urlHash: "b", event: "deferred" },
      { urlHash: "a", event: "admitted" },
      { urlHash: "c", event: "unrecognized" },
    ]),
    {
      reviewed: 2,
      pending: 0,
      admitted: 1,
      deferred: 1,
    },
  );
});

test("research candidate cap tracks available non-research candidates", () => {
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 8, runLimit: 30, share: 0.5 }),
    8,
  );
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 40, runLimit: 30, share: 0.5 }),
    15,
  );
  // No non-research admits must not starve research to zero.
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 0, runLimit: 30, share: 0.5 }),
    15,
  );
});

test("research inclusion cap falls with actual non-research accepts", () => {
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 4, runLimit: 30, share: 0.5 }),
    4,
  );
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 0, runLimit: 30, share: 0.5 }),
    15,
  );
});

test("research admission defers rather than records an over-quota include", () => {
  assert.deepEqual(
    researchAdmission({
      include: true,
      categoryId: "research",
      researchIncludedCount: 2,
      maxResearch: 2,
    }),
    {
      admitted: false,
      deferred: true,
      researchIncludedCount: 2,
    },
  );
});

test("research admission increments only accepted research items", () => {
  assert.deepEqual(
    researchAdmission({
      include: true,
      categoryId: "research",
      researchIncludedCount: 1,
      maxResearch: 2,
    }),
    {
      admitted: true,
      deferred: false,
      researchIncludedCount: 2,
    },
  );
});

test("research admission leaves rejects and other categories unchanged", () => {
  assert.deepEqual(
    researchAdmission({
      include: false,
      categoryId: "research",
      researchIncludedCount: 1,
      maxResearch: 2,
    }),
    {
      admitted: true,
      deferred: false,
      researchIncludedCount: 1,
    },
  );
  assert.deepEqual(
    researchAdmission({
      include: true,
      categoryId: "tools-oss",
      researchIncludedCount: 2,
      maxResearch: 2,
    }),
    {
      admitted: true,
      deferred: false,
      researchIncludedCount: 2,
    },
  );
});

test("countsAsResearch is true when either source or rule category is research", () => {
  assert.equal(countsAsResearch({ sourceCategory: "research", categoryId: "model-releases" }), true);
  assert.equal(countsAsResearch({ sourceCategory: "industry", categoryId: "research" }), true);
  assert.equal(countsAsResearch({ sourceCategory: "industry", categoryId: "industry" }), false);
  assert.equal(countsAsResearch({ sourceCategory: "research", categoryId: "research" }), true);
});

test("researchAdmission counts reclassified research sources toward the cap", () => {
  const atCap = { researchIncludedCount: 2, maxResearch: 2, include: true };
  // source=research, category reclassified to model-releases still uses a slot
  assert.equal(
    researchAdmission({ ...atCap, categoryId: "model-releases", sourceCategory: "research" }).deferred,
    true,
  );
  // true non-research is admitted even at cap
  assert.equal(
    researchAdmission({ ...atCap, categoryId: "industry", sourceCategory: "industry" }).deferred,
    false,
  );
});

test("researchCandidateCap keeps a share ceiling when research is alone", () => {
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 0, runLimit: 30, share: 0.5 }),
    15,
  );
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 0, runLimit: 10, share: 0.5 }),
    5,
  );
});

test("researchCandidateCap note: callers treat result as an upper bound", () => {
  // Documented contract: with zero non-research admits the cap is the pure
  // share ceiling (not 0), so research cannot starve forever.
  assert.equal(
    researchCandidateCap({ nonResearchCandidates: 0, runLimit: 30, share: 0.5 }),
    15,
  );
});
