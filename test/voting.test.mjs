import test from "node:test";
import assert from "node:assert/strict";
import {
  tallyVotes,
  settleOutcome,
  applyFounderVote,
  isBot,
  isAccountOldEnough,
  accountAgeVoteLogins,
} from "../lib/voting.mjs";
import { parseProposalType, parseTargetGroup, parseTargetRule } from "../lib/rules.mjs";
import { MIN_ACCOUNT_AGE_DAYS } from "../lib/constants.mjs";

const reactions = (list) =>
  list.map(([login, content]) => ({ user: { login }, content }));

test("account-age lookups include only eligible vote reactions", () => {
  const input = reactions([
    ["reader", "heart"],
    ["reader", "+1"],
    ["reader", "-1"],
    ["author", "+1"],
    ["github-actions[bot]", "-1"],
    ["other", "laugh"],
  ]);
  assert.deepEqual(accountAgeVoteLogins(input, "AUTHOR"), ["reader"]);
});

test("tallyVotes excludes issue author", () => {
  const t = tallyVotes(
    reactions([
      ["alice", "+1"],
      ["bob", "+1"],
      ["author", "+1"],
    ]),
    "author",
  );
  assert.equal(t.up, 2);
  assert.equal(t.down, 0);
  assert.equal(t.valid, 2);
});

test("tallyVotes excludes bots", () => {
  const t = tallyVotes(
    reactions([
      ["github-actions[bot]", "+1"],
      ["alice", "+1"],
    ]),
    "bob",
  );
  assert.equal(t.up, 1);
  assert.ok(isBot("github-actions[bot]"));
});

test("tallyVotes void when same user has +1 and -1", () => {
  const t = tallyVotes(
    reactions([
      ["alice", "+1"],
      ["alice", "-1"],
      ["bob", "+1"],
    ]),
    "bob",
  );
  assert.equal(t.voided, 1);
  assert.equal(t.up, 0);
  assert.equal(t.valid, 0);
});

test("applyFounderVote casting vote at 0 stars", () => {
  const r = applyFounderVote({
    stars: 0,
    reactions: reactions([["larrymou", "+1"]]),
    founderLogin: "larrymou",
    ceiling: 100,
  });
  assert.equal(r.founderVote, true);
  assert.equal(r.founderLogin, "larrymou");
});

test("applyFounderVote inactive at ceiling or above", () => {
  const r = applyFounderVote({
    stars: 100,
    reactions: reactions([["larrymou", "+1"]]),
    founderLogin: "larrymou",
    ceiling: 100,
  });
  assert.equal(r.founderVote, false);
  // negative stars clamps to 0 → F1 still possible; ceiling compare uses clamped value
  const neg = applyFounderVote({
    stars: -5,
    reactions: reactions([["larrymou", "+1"]]),
    founderLogin: "larrymou",
    ceiling: 100,
  });
  assert.equal(neg.founderVote, true);
});

test("applyFounderVote works when founder is issue author", () => {
  const r = applyFounderVote({
    stars: 5,
    reactions: reactions([["larrymou", "+1"]]),
    founderLogin: "larrymou",
    ceiling: 100,
  });
  assert.equal(r.founderVote, true);
  // public tally still excludes author
  const t = tallyVotes(reactions([["larrymou", "+1"]]), "larrymou");
  assert.equal(t.up, 0);
});

test("applyFounderVote false on founder down or void", () => {
  const down = applyFounderVote({
    stars: 0,
    reactions: reactions([["larrymou", "-1"]]),
    founderLogin: "larrymou",
    ceiling: 100,
  });
  assert.equal(down.founderVote, false);
  const voided = applyFounderVote({
    stars: 0,
    reactions: reactions([
      ["larrymou", "+1"],
      ["larrymou", "-1"],
    ]),
    founderLogin: "larrymou",
    ceiling: 100,
  });
  assert.equal(voided.founderVote, false);
});

test("parseProposalType strips HTML comments (stock template)", () => {
  const stock = `## Proposal Type\n\n<!-- pick one value below: new / amend / revoke -->\n\nnew\n\n## Category\nmodel-releases`;
  assert.equal(parseProposalType(stock), "new");
  assert.equal(parseProposalType("## Proposal Type\n\namend\n"), "amend");
  assert.equal(parseProposalType("## Proposal Type\n\nrevoke\n"), "revoke");
  assert.equal(parseProposalType("no section"), "new");
  // free prose must not flip the type
  assert.equal(
    parseProposalType("## Proposal Type\n\ndo not revoke, use amend\n"),
    "new",
  );
  assert.equal(
    parseProposalType("## Proposal Type\n\namend\n\n## Rule Text\nPlease do not revoke this."),
    "amend",
  );
});

test("parseTargetGroup/parseTargetRule match split template sections", () => {
  // Unfilled target sections (comment-only) and missing sections both parse as null
  assert.equal(
    parseTargetGroup("## Target Group\n\n<!-- Group number (e.g., 3). -->\n"),
    null,
  );
  assert.equal(
    parseTargetRule("## Target Rule\n\n<!-- Format: group-item (e.g., 3-1). -->\n"),
    null,
  );
  assert.equal(parseTargetGroup("## Rule Text\n\nno group section\n"), null);
  assert.equal(parseTargetRule("## Rule Text\n\nno rule section\n"), null);
  // Filled values parse as expected, including after template HTML comments
  assert.equal(parseTargetGroup("## Target Group\n\n3\n"), "3");
  assert.equal(parseTargetRule("## Target Rule\n\n3-1\n"), "3-1");
  assert.equal(
    parseTargetRule(
      "## Target Rule\n\n<!-- Existing rule id to replace. Format: group-item (e.g., 3-1). -->\n1-1\n",
    ),
    "1-1",
  );
});

test("split rule-proposal templates expose only their target field", async () => {
  const { readFile } = await import("node:fs/promises");
  const dir = new URL("../.github/ISSUE_TEMPLATE/", import.meta.url);
  const cases = [
    { file: "rule-proposal-new.md", type: "new", has: "## Target Group", lacks: "## Target Rule" },
    { file: "rule-proposal-amend.md", type: "amend", has: "## Target Rule", lacks: "## Target Group" },
    { file: "rule-proposal-revoke.md", type: "revoke", has: "## Target Rule", lacks: "## Target Group" },
  ];
  for (const c of cases) {
    const body = await readFile(new URL(c.file, dir), "utf8");
    // Strip YAML frontmatter before parsing body fields
    const text = body.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.equal(parseProposalType(text), c.type, c.file);
    assert.ok(text.includes(c.has), `${c.file} should include ${c.has}`);
    assert.ok(!text.includes(c.lacks), `${c.file} should not include ${c.lacks}`);
  }
});

test("account age gate drops young and unknown accounts", () => {
  assert.equal(MIN_ACCOUNT_AGE_DAYS, 30);
  const now = Date.parse("2026-09-22T00:00:00Z");
  assert.equal(isAccountOldEnough("2026-08-01T00:00:00Z", 30, now), true);
  assert.equal(isAccountOldEnough("2026-09-10T00:00:00Z", 30, now), false);
  assert.equal(isAccountOldEnough(null, 30, now), false);
  assert.equal(isAccountOldEnough("not-a-date", 30, now), false);
  assert.equal(isAccountOldEnough(null, 0, now), true);

  const rs = [
    { user: { login: "old" }, content: "+1" },
    { user: { login: "young" }, content: "+1" },
    { user: { login: "unknown" }, content: "+1" },
    { user: { login: "down-old" }, content: "-1" },
  ];
  const created = new Map([
    ["old", "2020-01-01T00:00:00Z"],
    ["young", "2026-09-20T00:00:00Z"],
    ["unknown", null],
    ["down-old", "2019-01-01T00:00:00Z"],
  ]);
  const t = tallyVotes(rs, "author", {
    minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
    now,
    getCreatedAt: (login) => created.get(login) ?? null,
  });
  assert.equal(t.up, 1);
  assert.equal(t.down, 1);
  assert.equal(t.valid, 2);
  assert.equal(t.droppedYoung, 1);
  assert.equal(t.droppedUnknown, 1);
  assert.deepEqual(
    t.dropped.map((d) => d.reason).sort(),
    ["unknown", "young"],
  );

  // definitive miss (ok:false, no reason) is unknown — not "young"
  const t2 = tallyVotes(rs, "author", {
    minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
    now,
    getCreatedAt: (login) =>
      login === "old"
        ? { ok: true, createdAt: "2020-01-01T00:00:00Z" }
        : { ok: false, createdAt: null },
  });
  assert.equal(t2.up, 1);
  assert.equal(t2.down, 0);
  assert.equal(t2.droppedYoung, 0);
  assert.equal(t2.droppedUnknown, 3);
  assert.equal(t2.lookupFailed, 0);
});

test("tallyVotes separates lookup_failed from unknown/ineligible", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const rs = reactions([
    ["old", "+1"],
    ["gone", "+1"],
    ["flaky", "+1"],
  ]);
  const t = tallyVotes(rs, "author", {
    minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
    now,
    getCreatedAt: (login) => {
      if (login === "old") return { ok: true, createdAt: "2020-01-01T00:00:00Z", reason: null };
      if (login === "gone") return { ok: false, createdAt: null, reason: "not_found" };
      return { ok: false, createdAt: null, reason: "lookup_failed" };
    },
  });
  assert.equal(t.up, 1);
  assert.equal(t.droppedUnknown, 1);
  assert.equal(t.lookupFailed, 1);
  const flaky = t.dropped.find((d) => d.login === "flaky");
  assert.equal(flaky.reason, "lookup_failed");
  const gone = t.dropped.find((d) => d.login === "gone");
  assert.equal(gone.reason, "unknown");
});

test("tallyVotes does not resolve account age for non-vote reactions", () => {
  const rs = reactions([
    ["flaky", "heart"],
    ["voter", "+1"],
  ]);
  const lookedUp = [];
  const t = tallyVotes(rs, "author", {
    minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
    getCreatedAt: (login) => {
      lookedUp.push(login);
      return login === "voter"
        ? { ok: true, createdAt: "2020-01-01T00:00:00Z" }
        : { ok: false, createdAt: null, reason: "lookup_failed" };
    },
  });
  assert.deepEqual(lookedUp, ["voter"]);
  assert.equal(t.up, 1);
  assert.equal(t.lookupFailed, 0);
});

test("settleOutcome founderVote ratifies with zero public votes", () => {
  assert.equal(
    settleOutcome({ up: 0, down: 0, quorum: 3, founderVote: true }),
    "ratified",
  );
});

test("settleOutcome uses approve-count quorum (no-show paradox fix)", () => {
  // up=2, down=0: only 2 approvals, quorum=3 → expired (not enough approvals)
  assert.equal(
    settleOutcome({ up: 2, down: 0, quorum: 3, founderVote: false }),
    "expired_no_quorum",
  );
  // up=3, down=10: quorum met but majority fails → defeated
  assert.equal(
    settleOutcome({ up: 3, down: 10, quorum: 3, founderVote: false }),
    "defeated",
  );
  // up=3, down=0: quorum + majority → ratified
  assert.equal(
    settleOutcome({ up: 3, down: 0, quorum: 3, founderVote: false }),
    "ratified",
  );
  // up=3, down=3: tie → defeated
  assert.equal(
    settleOutcome({ up: 3, down: 3, quorum: 3, founderVote: false }),
    "defeated",
  );
  // up=5, down=3: quorum + majority → ratified
  assert.equal(
    settleOutcome({ up: 5, down: 3, quorum: 3, founderVote: false }),
    "ratified",
  );
});

import {
  filterReactionsByDeadline,
  pickVoteDeadlineAt,
  isRuleProposalBody,
  hasFrozenTerminal,
} from "../lib/voting.mjs";

test("filterReactionsByDeadline drops post-deadline votes and keeps missing timestamps", () => {
  const recs = [
    { created_at: "2026-09-25T10:00:00Z", user: { login: "a" }, content: "+1" },
    { created_at: "2026-09-26T10:00:00Z", user: { login: "b" }, content: "+1" },
    { user: { login: "c" }, content: "+1" },
  ];
  const out = filterReactionsByDeadline(recs, "2026-09-25T12:00:00Z");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.user.login).sort(), ["a", "c"]);
  // No deadline → keep all
  assert.equal(filterReactionsByDeadline(recs, null).length, 3);
});

test("pickVoteDeadlineAt freezes first deadline and reset clears it", () => {
  assert.equal(pickVoteDeadlineAt([]), null);
  assert.equal(
    pickVoteDeadlineAt([{ voteDeadlineAt: "2026-09-25T10:00:00Z" }]),
    "2026-09-25T10:00:00Z",
  );
  // Reset after a deadline clears it (re-opened voting window)
  assert.equal(
    pickVoteDeadlineAt([
      { voteDeadlineAt: "2026-09-25T10:00:00Z" },
      { voteDeadlineReset: true },
    ]),
    null,
  );
  // A later freeze after reset re-opens a new window
  assert.equal(
    pickVoteDeadlineAt([
      { voteDeadlineAt: "2026-09-25T10:00:00Z" },
      { voteDeadlineReset: true },
      { voteDeadlineAt: "2026-09-26T10:00:00Z" },
    ]),
    "2026-09-26T10:00:00Z",
  );
});

test("isRuleProposalBody ignores ordinary feedback issues", () => {
  assert.equal(isRuleProposalBody("## Proposal Type\n\nnew\n"), true);
  assert.equal(isRuleProposalBody("## Proposal Type\n\nrevoke\n"), true);
  assert.equal(isRuleProposalBody("Bug: page is broken\n\n## Proposal Type\n"), true);
  assert.equal(isRuleProposalBody("Just some feedback, no proposal heading"), false);
  assert.equal(isRuleProposalBody(""), false);
  assert.equal(isRuleProposalBody(null), false);
});

test("countsTowardProposalQuota survives body edits via process labels", () => {
  // Author strips the heading from an already-filed same-day sibling.
  const edited = "Edited: no longer looks like a proposal";
  assert.equal(isRuleProposalBody(edited), false);
  assert.equal(countsTowardProposalQuota({ body: edited, labels: ["proposal"] }), true);
  assert.equal(countsTowardProposalQuota({ body: edited, labels: ["voting"] }), true);
  assert.equal(countsTowardProposalQuota({ body: edited, labels: ["rejected"] }), true);
  assert.equal(countsTowardProposalQuota({ body: edited, labels: ["ratified"] }), true);
  assert.equal(
    countsTowardProposalQuota({ body: edited, labels: ["ratified_pending_merge"] }),
    true,
  );
  assert.equal(countsTowardProposalQuota({ body: edited, labels: ["defeated"] }), true);
  assert.equal(countsTowardProposalQuota({ body: edited, labels: ["expired_no_quorum"] }), true);
  // Ordinary issue with no process label does not consume the budget.
  assert.equal(countsTowardProposalQuota({ body: edited, labels: [] }), false);
  assert.equal(countsTowardProposalQuota({ body: edited, labels: ["bug"] }), false);
});

test("hasFrozenTerminal accepts empty-reason reject verdict", () => {
  assert.equal(hasFrozenTerminal({ outcome: "ratified" }, null), true);
  assert.equal(hasFrozenTerminal(null, { verdict: "reject", reason: "" }), true);
  assert.equal(hasFrozenTerminal(null, { verdict: "reject" }), true);
  assert.equal(hasFrozenTerminal(null, { verdict: "pass" }), false);
  assert.equal(hasFrozenTerminal(null, null), false);
});

test("tallyVotes ages voters at the frozen deadline, not today", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const rs = reactions([["borderline", "+1"]]);
  // Account created 20 days before the deadline → ineligible at deadline
  const atDeadline = tallyVotes(rs, "author", {
    minAccountAgeDays: 30,
    now: Date.parse("2026-09-25T00:00:00Z"),
    getCreatedAt: () => ({ ok: true, createdAt: "2026-09-05T00:00:00Z", reason: null }),
  });
  assert.equal(atDeadline.up, 0);
  assert.equal(atDeadline.droppedYoung, 1);
  // Same voter is 26+ days old "today" — must NOT flip if we honor the freeze
  const atToday = tallyVotes(rs, "author", {
    minAccountAgeDays: 30,
    now,
    getCreatedAt: () => ({ ok: true, createdAt: "2026-09-05T00:00:00Z", reason: null }),
  });
  assert.equal(atToday.droppedYoung, 1); // still young at 26 days
  // A voter who crosses 30 days only after the deadline stays dropped when
  // eligibility is evaluated at the frozen deadline.
  const aged = tallyVotes(rs, "author", {
    minAccountAgeDays: 30,
    now: Date.parse("2026-09-25T00:00:00Z"),
    getCreatedAt: () => ({ ok: true, createdAt: "2026-08-20T00:00:00Z", reason: null }),
  });
  assert.equal(aged.up, 1);
});

import { missingTargetDisposition } from "../lib/voting.mjs";

test("missingTargetDisposition defers when rules checkout is stale", () => {
  assert.equal(missingTargetDisposition({ rulesFresh: true, found: true }), "ok");
  assert.equal(missingTargetDisposition({ rulesFresh: true, found: false }), "reject");
  assert.equal(missingTargetDisposition({ rulesFresh: false, found: false }), "defer");
  // Stale positive: a hit on a stale checkout cannot be trusted for status/category.
  assert.equal(missingTargetDisposition({ rulesFresh: false, found: true }), "defer");
});

import { latestSettleDeferred } from "../lib/voting.mjs";

test("latestSettleDeferred: later settlement supersedes defer", () => {
  assert.equal(latestSettleDeferred([]), false);
  assert.equal(latestSettleDeferred([{ outcome: "deferred_lookup_incomplete" }]), true);
  assert.equal(latestSettleDeferred([{ outcome: "deferred_rules_stale" }]), true);
  // Defer then a real settlement → not deferred anymore
  assert.equal(
    latestSettleDeferred([
      { outcome: "deferred_lookup_incomplete" },
      { outcome: "ratified_pending_merge" },
    ]),
    false,
  );
  // Settlement then a new defer → deferred again
  assert.equal(
    latestSettleDeferred([
      { outcome: "ratified" },
      { outcome: "deferred_lookup_incomplete" },
    ]),
    true,
  );
  // Non-outcome records ignored
  assert.equal(latestSettleDeferred([{ voteDeadlineAt: "x" }, { foo: 1 }]), false);
});

test("filterReactionsByDeadline + pickVoteDeadlineAt compose like settle", () => {
  const records = [
    { voteDeadlineAt: "2026-09-25T10:00:00Z" },
    { outcome: "deferred_lookup_incomplete", voteDeadlineAt: "2026-09-25T10:00:00Z" },
  ];
  const deadline = pickVoteDeadlineAt(records);
  assert.equal(deadline, "2026-09-25T10:00:00Z");
  const reactions = [
    { created_at: "2026-09-25T09:00:00Z", user: { login: "in" }, content: "+1" },
    { created_at: "2026-09-25T11:00:00Z", user: { login: "out" }, content: "+1" },
  ];
  const kept = filterReactionsByDeadline(reactions, deadline);
  assert.deepEqual(kept.map((r) => r.user.login), ["in"]);
  assert.equal(latestSettleDeferred(records), true);
});

test("missingTargetDisposition is fail-closed only when rules are fresh", () => {
  // Stale checkout + missing target → defer (never irreversible reject)
  assert.equal(missingTargetDisposition({ rulesFresh: false, found: false }), "defer");
  // Fresh checkout + missing target → reject is allowed
  assert.equal(missingTargetDisposition({ rulesFresh: true, found: false }), "reject");
  // Stale hit is a stale positive: status/category facts cannot be trusted
  assert.equal(missingTargetDisposition({ rulesFresh: false, found: true }), "defer");
  // Fresh hit is the only "ok"
  assert.equal(missingTargetDisposition({ rulesFresh: true, found: true }), "ok");
});

import { countsTowardProposalQuota } from "../lib/voting.mjs";

test("countsTowardProposalQuota: body alone is not enough after an edit", () => {
  assert.equal(countsTowardProposalQuota({ body: "## Proposal Type\n\nnew\n" }), true);
  assert.equal(countsTowardProposalQuota({ body: "Just feedback" }), false);
  // Body stripped, but the issue already entered the pipeline via a process label.
  assert.equal(
    countsTowardProposalQuota({ body: "Just feedback", labels: [{ name: "proposal" }] }),
    true,
  );
  assert.equal(
    countsTowardProposalQuota({ body: "Just feedback", labels: ["rejected"] }),
    true,
  );
  assert.equal(
    countsTowardProposalQuota({
      body: "Just feedback",
      labels: [{ name: "ratified_pending_merge" }],
    }),
    true,
  );
  assert.equal(
    countsTowardProposalQuota({ body: "Just feedback", labels: [{ name: "bug" }] }),
    false,
  );
});

test("countsTowardProposalQuota accepts explicit processLabels", () => {
  assert.equal(
    countsTowardProposalQuota({
      body: "Just feedback",
      labels: ["custom-stage"],
      processLabels: ["custom-stage"],
    }),
    true,
  );
});

import { latestFrozenVerdict } from "../lib/voting.mjs";

test("latestFrozenVerdict ignores tooling errors that shadow pass/reject", () => {
  assert.equal(latestFrozenVerdict([]), null);
  assert.equal(latestFrozenVerdict([{ verdict: "error" }]), null);
  // pass then a later tooling error → pass still frozen
  const frozenPass = latestFrozenVerdict([
    { verdict: "pass", reason: "ok" },
    { verdict: "error", reason: "snapshot commit failed" },
  ]);
  assert.equal(frozenPass?.verdict, "pass");
  // reject then error → reject still frozen
  const frozenReject = latestFrozenVerdict([
    { verdict: "reject", reason: "quota" },
    { verdict: "error", reason: "llm down" },
  ]);
  assert.equal(frozenReject?.verdict, "reject");
  // newest frozen wins when both pass and reject exist
  const latest = latestFrozenVerdict([
    { verdict: "pass" },
    { verdict: "reject", reason: "x" },
  ]);
  assert.equal(latest?.verdict, "reject");
});

import { snapshotFreezeDisposition } from "../lib/voting.mjs";

test("snapshotFreezeDisposition: lost snapshot + frozen pass defers, else rejects", () => {
  assert.equal(snapshotFreezeDisposition({ snapshotComplete: true }), "ok");
  assert.equal(snapshotFreezeDisposition({ hasFrozenPass: true, snapshotComplete: true }), "ok");
  assert.equal(snapshotFreezeDisposition({ hasFrozenPass: true, snapshotComplete: false }), "defer");
  assert.equal(snapshotFreezeDisposition({ hasFrozenPass: false, snapshotComplete: false }), "reject");
});

import {
  rulesDependentGateDisposition,
  snapshotRebuildableFrom,
  RULES_DEPENDENT_GATE_CODES,
} from "../lib/voting.mjs";

test("rulesDependentGateDisposition: pure-shape codes reject even on stale rules", () => {
  assert.equal(rulesDependentGateDisposition({ rulesFresh: true, code: "missing_target_rule" }), "reject");
  assert.equal(rulesDependentGateDisposition({ rulesFresh: false, code: "rule_text_too_short" }), "reject");
  assert.equal(rulesDependentGateDisposition({ rulesFresh: false, code: "invalid_category" }), "reject");
  assert.equal(rulesDependentGateDisposition({ rulesFresh: false, code: "" }), "reject");
});

test("rulesDependentGateDisposition: on-disk misses defer when rules are stale", () => {
  for (const code of RULES_DEPENDENT_GATE_CODES) {
    assert.equal(rulesDependentGateDisposition({ rulesFresh: true, code }), "reject");
    assert.equal(rulesDependentGateDisposition({ rulesFresh: false, code }), "defer");
  }
  assert.ok(RULES_DEPENDENT_GATE_CODES.includes("target_not_found"));
  assert.ok(RULES_DEPENDENT_GATE_CODES.includes("target_is_revoked"));
  assert.ok(RULES_DEPENDENT_GATE_CODES.includes("target_group_not_found"));
  assert.ok(RULES_DEPENDENT_GATE_CODES.includes("target_group_inactive"));
  assert.ok(RULES_DEPENDENT_GATE_CODES.includes("category_group_mismatch"));
});

test("snapshotRebuildableFrom only trusts the embedded snapshot block", () => {
  assert.equal(snapshotRebuildableFrom(null), false);
  assert.equal(snapshotRebuildableFrom({ verdict: "pass" }), false);
  assert.equal(snapshotRebuildableFrom({ verdict: "pass", proposalType: "new", ruleText: "x" }), false);
  assert.equal(snapshotRebuildableFrom({ snapshot: { proposalType: "new" } }), false);
  assert.equal(
    snapshotRebuildableFrom({
      snapshot: { proposalType: "new", ruleText: "Include items with a public URL." },
    }),
    true,
  );
});

import {
  normalizeModelVerdict,
  normalizeContentVerdict,
  prMatchesFrozenIdentity,
  pickVoteWindow,
  filterReactionsByWindow,
  extractReactionList,
} from "../lib/voting.mjs";

test("extractReactionList unwraps the settle-reactions envelope", () => {
  const list = [{ user: { login: "a" }, created_at: "2026-09-25T12:00:00.000Z" }];
  assert.deepEqual(extractReactionList({ issueNumber: 5, reactions: list }), list);
  assert.deepEqual(extractReactionList(list), list);
  assert.equal(extractReactionList({ reactions: {} }), null);
  assert.equal(extractReactionList({}), null);
  assert.equal(extractReactionList(null), null);
});

test("normalizeModelVerdict rejects unexpected JSON shapes", () => {
  assert.equal(normalizeModelVerdict({ verdict: "pass" }).verdict, "pass");
  assert.equal(normalizeModelVerdict({ verdict: "reject", reason: "x" }).verdict, "reject");
  assert.equal(normalizeModelVerdict({}).ok, false);
  assert.equal(normalizeModelVerdict({ verdict: "yes" }).ok, false);
  assert.equal(normalizeModelVerdict({ verdict: "maybe" }).ok, false);
  assert.equal(normalizeModelVerdict(null).ok, false);
});

test("normalizeContentVerdict requires an explicit boolean include", () => {
  assert.equal(normalizeContentVerdict({ include: true }).include, true);
  assert.equal(normalizeContentVerdict({ include: false }).include, false);
  assert.equal(normalizeContentVerdict({}).ok, false);
  assert.equal(normalizeContentVerdict({ include: "yes" }).ok, false);
  assert.equal(normalizeContentVerdict(null).ok, false);
});

test("normalizeContentVerdict treats include:true with bad matchedRuleId as protocol error", () => {
  const known = new Set(["3-1", "5-1"]);
  assert.equal(normalizeContentVerdict({ include: true, matchedRuleId: "3-1" }, { knownRuleIds: known }).ok, true);
  assert.equal(normalizeContentVerdict({ include: true }, { knownRuleIds: known }).ok, false);
  assert.equal(normalizeContentVerdict({ include: true, matchedRuleId: "9-9" }, { knownRuleIds: known }).ok, false);
  // Without a known-set, include alone is still valid (legacy callers).
  assert.equal(normalizeContentVerdict({ include: true }).ok, true);
});

import {
  latestSettleDeferredInWindow,
  prHeadMatchesFrozen,
  sortDecisionRecordsByEventTime,
} from "../lib/voting.mjs";

test("latestSettleDeferredInWindow ignores pre-reset defers", () => {
  assert.equal(
    latestSettleDeferredInWindow([
      { outcome: "deferred_lookup_incomplete" },
      { voteDeadlineReset: true },
    ]),
    false,
  );
  assert.equal(
    latestSettleDeferredInWindow([
      { outcome: "deferred_lookup_incomplete" },
      { voteDeadlineReset: true },
      { outcome: "deferred_lookup_incomplete" },
    ]),
    true,
  );
  assert.equal(latestSettleDeferredInWindow([{ outcome: "ratified" }]), false);
});

test("decision record ordering uses event timestamps across filename prefixes", () => {
  const records = [
    {
      filename: "settle-deferred-12-200.json",
      outcome: "deferred_lookup_incomplete",
      deferredAt: "2026-09-26T10:00:00.000Z",
    },
    {
      filename: "settle-vote-deadline-12-100.json",
      voteDeadlineReset: true,
      resetAt: "2026-09-26T09:00:00.000Z",
    },
  ];
  const ordered = sortDecisionRecordsByEventTime(records);
  assert.equal(ordered[0].voteDeadlineReset, true);
  assert.equal(latestSettleDeferredInWindow(ordered), true);

  const oldDeferThenReset = sortDecisionRecordsByEventTime([
    { outcome: "deferred_lookup_incomplete", deferredAt: "2026-09-25T10:00:00Z" },
    { voteDeadlineReset: true, resetAt: "2026-09-26T09:00:00Z" },
  ]);
  assert.equal(latestSettleDeferredInWindow(oldDeferThenReset), false);
});

test("prHeadMatchesFrozen refuses unknown or changed heads", () => {
  const pr = { head: { sha: "abc123" } };
  assert.equal(prHeadMatchesFrozen(pr, "abc123"), true);
  assert.equal(prHeadMatchesFrozen(pr, "other"), false);
  assert.equal(prHeadMatchesFrozen(pr, null), false);
  assert.equal(prHeadMatchesFrozen({ head: {} }, "abc123"), false);
});

test("prMatchesFrozenIdentity blocks forks and wrong numbers", () => {
  const me = {
    number: 12,
    head: {
      ref: "rule/3-1-from-5",
      repo: { full_name: "o/r" },
      label: "o:rule/3-1-from-5",
    },
    base: { ref: "main", repo: { full_name: "o/r" } },
  };
  assert.equal(prMatchesFrozenIdentity(me, { expectedNumber: 12, baseOwner: "o", baseRepo: "r" }), true);
  assert.equal(prMatchesFrozenIdentity(me, { expectedNumber: 13, baseOwner: "o", baseRepo: "r" }), false);
  const frozenRequest = {
    expectedNumber: 12,
    baseOwner: "o",
    baseRepo: "r",
    expectedHeadRef: "rule/3-1-from-5",
    expectedBaseRef: "main",
  };
  assert.equal(prMatchesFrozenIdentity(me, frozenRequest), true);
  assert.equal(
    prMatchesFrozenIdentity({ ...me, head: { ...me.head, ref: "rule/other-from-5" } }, frozenRequest),
    false,
  );
  assert.equal(
    prMatchesFrozenIdentity({ ...me, base: { ...me.base, ref: "release" } }, frozenRequest),
    false,
  );
  assert.equal(
    prMatchesFrozenIdentity({
      ...me,
      base: { ...me.base, repo: { full_name: "other/repo" } },
    }, frozenRequest),
    false,
  );
  const fork = {
    ...me,
    head: { ...me.head, repo: { full_name: "evil/r" }, label: "evil:rule/3-1-from-5" },
  };
  assert.equal(prMatchesFrozenIdentity(fork, { expectedNumber: 12, baseOwner: "o", baseRepo: "r" }), false);
  assert.equal(
    prMatchesFrozenIdentity({ ...me, head: { ...me.head, repo: null } }, frozenRequest),
    false,
  );
  assert.equal(prMatchesFrozenIdentity(null, { baseOwner: "o", baseRepo: "r" }), false);
});

test("pickVoteWindow tracks start/end and reset with new start", () => {
  const window = pickVoteWindow([
    { voteWindowStartAt: "2026-09-24T10:00:00.000Z" },
    { voteDeadlineAt: "2026-09-25T03:00:00.000Z" },
  ]);
  assert.equal(window.startAt, "2026-09-24T10:00:00.000Z");
  assert.equal(window.endAt, "2026-09-25T03:00:00.000Z");

  const reopened = pickVoteWindow([
    { voteWindowStartAt: "2026-09-24T10:00:00.000Z" },
    { voteDeadlineAt: "2026-09-25T03:00:00.000Z" },
    { voteDeadlineReset: true, voteWindowStartAt: "2026-09-26T10:00:00.000Z" },
    { voteDeadlineAt: "2026-09-27T03:00:00.000Z" },
  ]);
  assert.equal(reopened.startAt, "2026-09-26T10:00:00.000Z");
  assert.equal(reopened.endAt, "2026-09-27T03:00:00.000Z");
});

test("filterReactionsByWindow drops pre-start and post-end reactions", () => {
  const reactions = [
    { user: { login: "old" }, created_at: "2026-09-20T00:00:00.000Z" },
    { user: { login: "in" }, created_at: "2026-09-25T12:00:00.000Z" },
    { user: { login: "late" }, created_at: "2026-09-28T00:00:00.000Z" },
    { user: { login: "nots" }, created_at: null },
  ];
  const kept = filterReactionsByWindow(reactions, {
    startAt: "2026-09-24T10:00:00.000Z",
    endAt: "2026-09-27T03:00:00.000Z",
  });
  assert.deepEqual(
    kept.map((r) => r.user.login).sort(),
    ["in", "nots"],
  );
});

test("tallyVotes keeps void when one of a dual reaction lacks created_at", () => {
  const reactions = [
    { content: "+1", user: { login: "alice", created_at: "2020-01-01T00:00:00Z" } },
    { content: "-1", user: { login: "alice" } }, // missing created_at
  ];
  const t = tallyVotes(reactions, "author", {
    minAccountAgeDays: 30,
    now: Date.parse("2026-09-24T00:00:00Z"),
    getCreatedAt: () => ({ ok: true, createdAt: "2020-01-01T00:00:00Z" }),
  });
  assert.equal(t.voided, 1);
  assert.equal(t.up, 0);
  assert.equal(t.down, 0);
});
