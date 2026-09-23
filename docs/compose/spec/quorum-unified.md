---
feature: quorum-unified
status: delivered
updated: 2026-09-22
branch: main
commits: # filled at delivery
---

# Quorum Unified Formula + Approve-Count

## Report

## [S1] Problem

Current quorum has three stages (S0/S1/S2) with discontinuities and linear explosion at scale. Quorum counts total valid votes (`up + down`), creating no-show paradox (more opponents helps meet quorum). The first unified formula (`floor(log2(stars+1))+3`) made 100★ require 9 approvals — too high when F1 also turns off at 100★.

## [S2] Design

### Unified formula

```
quorum = min(25, max(3, floor(2 * log2(stars + 1)) - 7))
```

Stars stay the electorate proxy (simple, public). Formula is an engineering choice for this experiment, not a claim about formal voting theory. Steep log2 (×2, −7) keeps 100★ at 6 while medium/large repos hit the cap quickly.

| stars | quorum |
|---|---|
| 0 | 3 |
| 100 | 6 |
| 1000 | 12 |
| 10000 | 19 |
| ∞ | 25 |

### Approve-count quorum (research: no-show paradox)

Change `settleOutcome` from `valid >= quorum` to `up >= quorum`:

```
pass = up >= quorum AND up > down
```

- Quorum counts **approve votes only** (not total)
- Majority check `up > down` remains
- F1 founder vote unchanged (short-circuits before quorum)

### Auto-merge star gate

Replace `stage === "S0"` auto-merge blocks with `canAutoMerge(stars)` / `AUTO_MERGE_MIN_STARS = 200`. Stage labels become display-only.

### Stage label

Keep `stage` field for display (S0/S1/S2) but derive from stars:
- `stars < 200` → S0
- `stars < 1000` → S1
- `stars >= 1000` → S2

### Governance lock (experimental)

Quorum formula, floor/cap, F1, and auto-merge stars are code constants. Community Rule Proposals **cannot** amend them (M5). Documented in README/CONTRIBUTING: this is intentional while the mechanism is validated; only maintainers change `lib/constants.mjs`.

### Voting freeze + deadline + account age

- When a proposal enters `voting`, snapshot freezes `starsAtVotingStart` and `quorumAtVotingStart`
- Settlement uses those frozen values for quorum and F1; live stars only for auto-merge safety
- Vote deadline is the **settle run** (Mon 03:00 UTC); later reactions ignored. Stated on Pages + issue comment
- `MIN_ACCOUNT_AGE_DAYS = 30`: votes from accounts younger than 30 days (or unknown `created_at`) are dropped before auto-merge can open

## [S3] Out of Scope

- F1 founder vote mechanism
- Vote eligibility / bot filtering
- Display caps / UI changes

## Tasks

- [x] T1: Replace COLD_START with `quorumForStars()` + `stageForStars()` using unified formula — acceptance: `stageForStars(0).quorum === 3`, `stageForStars(100).quorum === 6`, `stageForStars(10000).quorum === 19`, `stageForStars(100000).quorum === 25`, `stageForStars(1e9).quorum === 25` (covers: S2)
- [x] T2: Change `settleOutcome` to check `up >= quorum` instead of `valid >= quorum` — acceptance: `up=2, down=0, quorum=3` → `expired_no_quorum`; `up=3, down=10, quorum=3` → `defeated`; `up=3, down=0, quorum=3` → `ratified` (covers: S2)
- [x] T3: Auto-merge via `canAutoMerge(stars)` at `AUTO_MERGE_MIN_STARS=200`; stage display-only — acceptance: `canAutoMerge(199)===false`, `canAutoMerge(200)===true` (covers: S2)
- [x] T4: Freeze `starsAtVotingStart`/`quorumAtVotingStart` at voting entry; deadline=settle on page; account age ≥ 30d before auto-merge; hygiene (parseProposalType first-line, F1 clamp, vote wording, public-vote note) — acceptance: `npm test` all green (covers: S2)
