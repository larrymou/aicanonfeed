import test from "node:test";
import assert from "node:assert/strict";
import {
  tallyVotes,
  settleOutcome,
  applyFounderVote,
  isBot,
  isAccountOldEnough,
} from "../lib/voting.mjs";
import { parseProposalType, parseTargetGroup, parseTargetRule } from "../lib/rules.mjs";
import { MIN_ACCOUNT_AGE_DAYS } from "../lib/constants.mjs";

const reactions = (list) =>
  list.map(([login, content]) => ({ user: { login }, content }));

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

test("parseTargetGroup/parseTargetRule match stock template sections", () => {
  // Stock template: Target Group is comment-only (null), Target Rule is comment-only (null)
  const stock = [
    "## Proposal Type",
    "",
    "<!-- pick one value below: new / amend / revoke -->",
    "",
    "new",
    "",
    "## Category",
    "",
    "<!-- model-releases / research / industry / policy / tools-oss -->",
    "",
    "model-releases",
    "",
    "## Target Group",
    "",
    "<!-- Required for new: group number to add the item to (e.g., 3). -->",
    "<!-- Leave empty for amend and revoke. -->",
    "",
    "## Target Rule",
    "",
    "<!-- Required for amend and revoke. Format: group-item (e.g., 3-1). -->",
    "<!-- Leave empty for new proposals (use ## Target Group instead). -->",
    "",
    "## Rule Text",
    "",
    "<!-- English. Actionable inclusion determination. -->",
  ].join("\n");
  assert.equal(parseTargetGroup(stock), null);
  assert.equal(parseTargetRule(stock), null);
  // Filled values parse as expected
  assert.equal(parseTargetGroup("## Target Group\n\n3\n"), "3");
  assert.equal(parseTargetRule("## Target Rule\n\n3-1\n"), "3-1");
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

  // lookup failed (ok:false) is unknown — not "young"
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
