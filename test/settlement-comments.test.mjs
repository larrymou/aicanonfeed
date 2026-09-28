import test from "node:test";
import assert from "node:assert/strict";
import {
  settlementCommentIdentity,
  settlementCommentMarker,
} from "../lib/settlement-comments.mjs";

test("settlement markers stay stable when recover rewrites settledAt", () => {
  const first = {
    outcome: "ratified_pr_abandoned",
    voteOutcome: "ratified",
    voteDeadlineAt: "2026-09-26T03:00:00.000Z",
    prNumber: 7,
    settledAt: "2026-09-26T10:00:00.000Z",
  };
  const retry = {
    ...first,
    settledAt: "2026-10-03T10:00:00.000Z", // recover bumps this
  };

  assert.equal(settlementCommentIdentity(first), settlementCommentIdentity(retry));
  assert.equal(settlementCommentMarker(42, first), settlementCommentMarker(42, retry));
});

test("settlement markers differ across voting rounds and kinds", () => {
  const round1 = {
    outcome: "defeated",
    voteDeadlineAt: "2026-09-26T03:00:00.000Z",
  };
  const round2 = {
    outcome: "defeated",
    voteDeadlineAt: "2026-10-03T03:00:00.000Z",
  };
  assert.notEqual(settlementCommentIdentity(round1), settlementCommentIdentity(round2));
  assert.notEqual(
    settlementCommentMarker(42, round1, "retry-pr"),
    settlementCommentMarker(42, round1),
  );
});

test("voteOutcome participates in the comment identity", () => {
  const a = { outcome: "rejected", voteOutcome: "ratified", voteDeadlineAt: "t" };
  const b = { outcome: "rejected", voteOutcome: "defeated", voteDeadlineAt: "t" };
  assert.notEqual(settlementCommentIdentity(a), settlementCommentIdentity(b));
});
