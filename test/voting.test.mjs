import test from "node:test";
import assert from "node:assert/strict";
import { tallyVotes, settleOutcome, applyFounderVote, isBot } from "../lib/voting.mjs";

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
  // Inline regex matching governance.mjs parseProposalType (avoid importing side-effect module)
  function parse(body) {
    const m = body.match(/^\s*##\s*Proposal Type\s*\n+([\s\S]*?)(?=\n\s*##\s|\n*$)/im);
    if (!m) return "new";
    const raw = m[1].replace(/<!--[\s\S]*?-->/g, "").toLowerCase().trim();
    if (raw.includes("revoke")) return "revoke";
    if (raw.includes("amend")) return "amend";
    return "new";
  }
  const stock = `## Proposal Type\n\n<!-- pick one value below: new / amend / revoke -->\n\nnew\n\n## Category\nmodel-releases`;
  assert.equal(parse(stock), "new");
  assert.equal(parse("## Proposal Type\n\namend\n"), "amend");
  assert.equal(parse("## Proposal Type\n\nrevoke\n"), "revoke");
  assert.equal(parse("no section"), "new");
});

test("settleOutcome founderVote ratifies with zero public votes", () => {
  assert.equal(
    settleOutcome({ up: 0, down: 0, valid: 0, quorum: 3, founderVote: true }),
    "ratified",
  );
});

test("settleOutcome without founderVote uses quorum and majority", () => {
  assert.equal(
    settleOutcome({ up: 1, down: 0, valid: 1, quorum: 3, founderVote: false }),
    "expired_no_quorum",
  );
  assert.equal(
    settleOutcome({ up: 2, down: 2, valid: 4, quorum: 3, founderVote: false }),
    "defeated",
  );
  assert.equal(
    settleOutcome({ up: 3, down: 1, valid: 4, quorum: 3, founderVote: false }),
    "ratified",
  );
});
