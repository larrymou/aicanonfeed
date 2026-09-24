import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProposalQuota,
  isProposalQuotaExempt,
  startOfUtcDay,
} from "../lib/rules.mjs";
import {
  FOUNDER_LOGIN,
  FOUNDER_STAR_CEILING,
  PROPOSAL_OPEN_LIMIT,
  PROPOSAL_DAILY_LIMIT,
} from "../lib/constants.mjs";

const T0 = "2026-09-24T08:00:00.000Z";
const T1 = "2026-09-24T09:00:00.000Z";
const T_YESTERDAY = "2026-09-23T20:00:00.000Z";

test("quota constants stay aligned with the seriousness gate", () => {
  assert.equal(PROPOSAL_OPEN_LIMIT, 1);
  assert.equal(PROPOSAL_DAILY_LIMIT, 1);
  assert.equal(FOUNDER_STAR_CEILING, 100);
  assert.equal(FOUNDER_LOGIN, "larrymou");
});

test("founder is exempt below the F1 star ceiling, case-insensitive", () => {
  assert.equal(isProposalQuotaExempt({ login: "larrymou", stars: 0 }), true);
  assert.equal(isProposalQuotaExempt({ login: "LarryMou", stars: 99 }), true);
  assert.equal(isProposalQuotaExempt({ login: "larrymou", stars: 100 }), false);
  assert.equal(isProposalQuotaExempt({ login: "someone", stars: 0 }), false);
  assert.equal(isProposalQuotaExempt({ login: "", stars: 0 }), false);
});

test("founder cold-start ignores open and daily limits", () => {
  const gate = evaluateProposalQuota({
    login: FOUNDER_LOGIN,
    stars: 0,
    issueNumber: 30,
    openByAuthor: [
      { number: 10, createdAt: T_YESTERDAY },
      { number: 20, createdAt: T0 },
      { number: 30, createdAt: T1 },
    ],
    createdTodayByAuthor: [
      { number: 20, createdAt: T0 },
      { number: 30, createdAt: T1 },
    ],
  });
  assert.deepEqual(gate, { ok: true, exempt: true });
});

test("founder at or above ceiling gets normal limits", () => {
  const gate = evaluateProposalQuota({
    login: FOUNDER_LOGIN,
    stars: FOUNDER_STAR_CEILING,
    issueNumber: 30,
    openByAuthor: [
      { number: 20, createdAt: T0 },
      { number: 30, createdAt: T1 },
    ],
    createdTodayByAuthor: [
      { number: 20, createdAt: T0 },
      { number: 30, createdAt: T1 },
    ],
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "open_limit");
});

test("non-founder with one open proposal filed today passes", () => {
  const gate = evaluateProposalQuota({
    login: "alice",
    stars: 0,
    issueNumber: 5,
    openByAuthor: [{ number: 5, createdAt: T0 }],
    createdTodayByAuthor: [{ number: 5, createdAt: T0 }],
  });
  assert.deepEqual(gate, { ok: true, exempt: false });
});

test("in-flight limit keeps the oldest open proposal only", () => {
  const open = [
    { number: 7, createdAt: T0 },
    { number: 8, createdAt: T1 },
  ];
  const older = evaluateProposalQuota({
    login: "alice",
    stars: 12,
    issueNumber: 7,
    openByAuthor: open,
    createdTodayByAuthor: open,
  });
  assert.deepEqual(older, { ok: true, exempt: false });

  const newer = evaluateProposalQuota({
    login: "alice",
    stars: 12,
    issueNumber: 8,
    openByAuthor: open,
    createdTodayByAuthor: open,
  });
  assert.equal(newer.ok, false);
  assert.equal(newer.code, "open_limit");
  assert.match(newer.message, /open rule proposal/i);
});

test("daily limit rejects a second proposal in the same UTC day", () => {
  const createdToday = [
    { number: 7, createdAt: T0 },
    { number: 8, createdAt: T1 },
  ];
  const second = evaluateProposalQuota({
    login: "alice",
    stars: 12,
    issueNumber: 8,
    openByAuthor: [{ number: 8, createdAt: T1 }],
    createdTodayByAuthor: createdToday,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "daily_limit");
  assert.match(second.message, /UTC day/i);
});

test("earlier rejected proposal the same day still consumes the daily slot", () => {
  // #7 already closed/rejected; #8 is the only open one but is the second filing today.
  const gate = evaluateProposalQuota({
    login: "alice",
    stars: 12,
    issueNumber: 8,
    openByAuthor: [{ number: 8, createdAt: T1 }],
    createdTodayByAuthor: [
      { number: 7, createdAt: T0 },
      { number: 8, createdAt: T1 },
    ],
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "daily_limit");
});

test("tie-break falls back to issue number when timestamps match", () => {
  const open = [
    { number: 9, createdAt: T0 },
    { number: 8, createdAt: T0 },
  ];
  const first = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 8,
    openByAuthor: open,
    createdTodayByAuthor: open,
  });
  assert.equal(first.ok, true);
  const second = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 9,
    openByAuthor: open,
    createdTodayByAuthor: open,
  });
  assert.equal(second.code, "open_limit");
});

test("invalid or missing createdAt still orders by issue number", () => {
  const open = [
    { number: 11, createdAt: "nope" },
    { number: 10, createdAt: null },
    { number: 12, createdAt: "" },
  ];
  const oldest = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 10,
    openByAuthor: open,
    createdTodayByAuthor: open,
  });
  assert.deepEqual(oldest, { ok: true, exempt: false });

  const middle = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 11,
    openByAuthor: open,
    createdTodayByAuthor: open,
  });
  assert.equal(middle.code, "open_limit");

  const newest = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 12,
    openByAuthor: open,
    createdTodayByAuthor: open,
  });
  assert.equal(newest.code, "open_limit");
});

test("three open proposals: only the oldest slot is allowed", () => {
  const open = [
    { number: 21, createdAt: "2026-09-24T07:00:00.000Z" },
    { number: 22, createdAt: "2026-09-24T08:00:00.000Z" },
    { number: 23, createdAt: "2026-09-24T09:00:00.000Z" },
  ];
  assert.equal(
    evaluateProposalQuota({
      login: "alice",
      stars: 1,
      issueNumber: 21,
      openByAuthor: open,
      createdTodayByAuthor: open,
    }).ok,
    true,
  );
  assert.equal(
    evaluateProposalQuota({
      login: "alice",
      stars: 1,
      issueNumber: 22,
      openByAuthor: open,
      createdTodayByAuthor: open,
    }).code,
    "open_limit",
  );
  assert.equal(
    evaluateProposalQuota({
      login: "alice",
      stars: 1,
      issueNumber: 23,
      openByAuthor: open,
      createdTodayByAuthor: open,
    }).code,
    "open_limit",
  );
});

test("current missing from open list fails closed when the author already has one open", () => {
  const gate = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 2,
    openByAuthor: [{ number: 1, createdAt: T0 }],
    createdTodayByAuthor: [{ number: 2, createdAt: T1 }],
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "open_limit");

  // Same for the daily list: second filing of the day fails closed if omitted from the list.
  const daily = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 2,
    openByAuthor: [{ number: 2, createdAt: T1 }],
    createdTodayByAuthor: [{ number: 1, createdAt: T0 }],
  });
  assert.equal(daily.ok, false);
  assert.equal(daily.code, "daily_limit");
});

test("open_limit wins over daily_limit when both apply", () => {
  const rows = [
    { number: 7, createdAt: T0 },
    { number: 8, createdAt: T1 },
  ];
  const gate = evaluateProposalQuota({
    login: "alice",
    stars: 1,
    issueNumber: 8,
    openByAuthor: rows,
    createdTodayByAuthor: rows,
  });
  assert.equal(gate.code, "open_limit");
});

test("startOfUtcDay anchors the daily budget to UTC midnight", () => {
  assert.equal(startOfUtcDay(Date.parse("2026-09-24T07:59:59.999Z")), "2026-09-24T00:00:00.000Z");
  assert.equal(startOfUtcDay(Date.parse("2026-09-24T23:00:00.000Z")), "2026-09-24T00:00:00.000Z");
  assert.equal(startOfUtcDay(Date.parse("2026-09-25T00:00:00.000Z")), "2026-09-25T00:00:00.000Z");
});
