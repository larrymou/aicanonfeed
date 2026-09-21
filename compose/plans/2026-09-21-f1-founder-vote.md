# F1 Founder Casting Vote (cold-start) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While repo stars `< 100`, the named founder’s 👍 is a casting vote that ratifies a voting proposal (even if the founder is the issue author); at `≥ 100` stars public quorum applies unchanged.

**Architecture:** Extract tally/settle into `lib/voting.mjs` (pure, testable). Add `FOUNDER_LOGIN` / `FOUNDER_STAR_CEILING` constants. `settleOutcome` gains optional `founderVote`. `governance.mjs` computes founderVote from reactions + stars and records it in settlement decisions/PR text. Docs updated (README, CONTRIBUTING, SECURITY).

**Tech Stack:** Node ESM, `node:test`.

## Global Constraints

- Author reaction still excluded from **public** tally; bots excluded always
- `MIN_QUORUM` stays 3; star-stage table unchanged
- Founder seat only when `stars < FOUNDER_STAR_CEILING` (100)
- Founder 👎 or void does **not** trigger casting vote
- S0 still **no auto-merge** after founder ratify — maintainer merges the rule PR
- Settlement JSON must include `founderVote` (+ `founderLogin` when used)
- Community Rule Proposals still cannot change this mechanism (M5)
- `npm test` green

## Files

| File | Change |
|---|---|
| `lib/constants.mjs` | Add `FOUNDER_LOGIN`, `FOUNDER_STAR_CEILING` |
| `lib/voting.mjs` | **Create** — `isBot`, `tallyVotes`, `settleOutcome`, `applyFounderVote` |
| `test/voting.test.mjs` | **Create** — unit tests |
| `scripts/governance.mjs` | Import voting helpers; wire founderVote; comment + writeDecision + PR body |
| `README.md` | Founder seat table note |
| `CONTRIBUTING.md` | Vote rules + founder seat + ties |
| `SECURITY.md` | Why founder seat exists; audit fields |
| `package.json` | Already `test/*.test.mjs` — no change |

---

### Task 1: Pure voting + F1 constants + tests

- [ ] Add to `lib/constants.mjs`:

```javascript
/** Cold-start F1: founder casting vote while stars are below ceiling. */
export const FOUNDER_LOGIN = "larrymou";
export const FOUNDER_STAR_CEILING = 100;
```

- [ ] Create `lib/voting.mjs`:

```javascript
export function isBot(login) {
  return /\[bot\]$/i.test(login || "");
}

/**
 * Tally GitHub issue reactions.
 * Author is excluded from the public tally (spec).
 */
export function tallyVotes(reactions, authorLogin) {
  const byUser = new Map();
  for (const r of reactions || []) {
    const login = r.user?.login;
    const content = r.content;
    if (!login) continue;
    if (login.toLowerCase() === String(authorLogin || "").toLowerCase()) continue;
    if (isBot(login)) continue;
    if (!byUser.has(login)) byUser.set(login, new Set());
    byUser.get(login).add(content);
  }
  let up = 0;
  let down = 0;
  let voided = 0;
  const detail = [];
  for (const [login, set] of byUser) {
    const hasUp = set.has("+1");
    const hasDown = set.has("-1");
    if (hasUp && hasDown) {
      voided++;
      detail.push({ login, vote: "void" });
      continue;
    }
    if (hasUp) {
      up++;
      detail.push({ login, vote: "up" });
    } else if (hasDown) {
      down++;
      detail.push({ login, vote: "down" });
    }
  }
  const valid = up + down;
  return { up, down, voided, valid, detail };
}

/**
 * F1: founder 👍 while stars < ceiling counts as a casting vote
 * even if that login is the issue author (not in public tally).
 * Founder 👎 or void → no casting vote.
 */
export function applyFounderVote({ stars, reactions, founderLogin, ceiling }) {
  if (!founderLogin) {
    return { founderVote: false, founderLogin: null };
  }
  const n = Number(stars) || 0;
  const cap = Number(ceiling) || 0;
  if (n >= cap) return { founderVote: false, founderLogin: String(founderLogin) };
  const f = String(founderLogin).toLowerCase();
  const mine = (reactions || []).filter(
    (r) => String(r.user?.login || "").toLowerCase() === f,
  );
  if (!mine.length) return { founderVote: false, founderLogin: String(founderLogin) };
  const hasUp = mine.some((r) => r.content === "+1");
  const hasDown = mine.some((r) => r.content === "-1");
  const founderVote = hasUp && !hasDown;
  return { founderVote, founderLogin: String(founderLogin) };
}

export function settleOutcome({ up, down, valid, quorum, founderVote = false }) {
  if (founderVote) return "ratified";
  if (valid < quorum) return "expired_no_quorum";
  if (up > down) return "ratified";
  return "defeated";
}
```

- [ ] Create `test/voting.test.mjs` with cases:
  - author excluded from tally
  - bot excluded
  - 👍+👎 → void
  - `applyFounderVote` stars=0 + founder 👍 → true
  - `applyFounderVote` stars=100 + founder 👍 → false
  - `applyFounderVote` founder author 👍 → still true
  - founder 👎 → false
  - `settleOutcome` founderVote=true + valid=0 → ratified
  - `settleOutcome` founderVote=false + valid<quorum → expired_no_quorum
  - tie → defeated; up>down → ratified

- [ ] `npm test` — all pass

### Task 2: Wire governance + docs

- [ ] `scripts/governance.mjs`: remove local `isBot`/`tallyVotes`/`settleOutcome`; import from `../lib/voting.mjs`; import `FOUNDER_LOGIN`, `FOUNDER_STAR_CEILING`
- [ ] In `settlePhase` after tally:

```javascript
const { founderVote, founderLogin: founderUsed } = applyFounderVote({
  stars,
  reactions,
  founderLogin: FOUNDER_LOGIN,
  ceiling: FOUNDER_STAR_CEILING,
});
let outcome = settleOutcome({
  up: tally.up,
  down: tally.down,
  valid: tally.valid,
  quorum: stageInfo.quorum,
  founderVote,
});
```

- [ ] PR body / settlement comment / `writeDecision` include `founderVote`
- [ ] README + CONTRIBUTING + SECURITY founder-seat docs
- [ ] `npm test` + commit

## Self-Review

- F1-only casting vote; public stages table intact
- Pure functions tested; audit fields present
- S0 no-auto-merge unchanged

## Execution Handoff

Pref: `execution-style: subagent` — **inline this time** (subagent spawn failed earlier; user asked to change mechanism now).
