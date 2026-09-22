---
feature: mvp-hardening
status: delivered
updated: 2026-09-22
branch: main
commits: 30db4bf..HEAD
---

# MVP Hardening — C1 + C3 + I1

## Report

**What was built** — Three governance integrity fixes:
1. `parseProposalType` now strips HTML comments before keyword matching; stock issue template no longer falsely parses as `revoke`. Regression test asserts stock template → `"new"`.
2. Settlement now rejects when snapshot is missing or lacks `proposalType`/`ruleText` — prevents pre-review bypass via manual `voting` label.
3. Snapshot guard now compares `proposalType` (live vs snap); pre-review snapshot is no longer overwritten at ratify (settlement info written to `writeDecision` instead).

**Verification** — `npm test` → 36/36 pass (was 35, +1 regression test).

**Journey log** — `governance.mjs` runs `main()` on import; test uses inline regex instead of importing. Pre-review snapshot at line 733 unchanged (correct). `writeSnapshot` calls at ratify replaced with `writeDecision` to preserve freeze.

## [S1] Problem

Governance mechanism has three bugs that compromise integrity at MVP stage:

1. **C1**: Stock issue template's `<!-- new | amend | revoke -->` comment contains "revoke"; `parseProposalType` does not strip HTML comments → every unedited template parses as `revoke`.
2. **C3**: Settlement trusts `voting` label without verifying snapshot exists; missing snapshot → live body used → pre-review bypass.
3. **I1**: Snapshot guard skips when `ruleText` is falsy; does not compare `proposalType`; snapshot overwritten at ratify.

## [S2] Design

### C1 fix
- `parseProposalType`: strip `<!--...-->` before keyword matching (same as `parseCategory`/`parseRuleText`).
- Template comment: change to `<!-- pick one -->` (no type words).
- Regression test: stock template body → `"new"`.

### C3 fix
- At settle: if `outcome === "ratified"` and `!loadSnapshot(issueNumber)` → `rejected_by_guard`.
- Snapshot must contain `proposalType` and `ruleText` fields.

### I1 fix
- Always compare `parseProposalType(live body)` vs `snap.proposalType`; reject on mismatch.
- Reject settle when snapshot lacks `proposalType` or `ruleText`.
- Do NOT overwrite pre-review snapshot at ratify (write to separate file or leave unchanged).

### Out of scope (documented as accepted)
- I2 (amend category rename) — deferred
- I5 (append-only CI check) — deferred
- I6 (regex false-positive narrowing) — deferred
- Cold-start F1 — unchanged per user decision

## [S3] Out of Scope

- Amend category-change rename
- Append-only decisions CI check
- Rule-guard regex narrowing
- Any change to F1 / quorum / voting mechanism
- UI/UX changes

## Tasks

- [ ] T1: Fix `parseProposalType` to strip HTML comments + template comment + regression test — acceptance: stock template body parses as `"new"` (covers: S2)
- [ ] T2: Reject settle when snapshot missing or incomplete — acceptance: missing snapshot → `rejected_by_guard` (covers: S2)
- [ ] T3: Compare `proposalType` in snapshot guard; prevent snapshot overwrite at ratify — acceptance: type mismatch → `rejected_by_guard`; pre-review snapshot preserved after ratify (covers: S2; depends: T2)
- [ ] T4: Run `npm test` + verify all pass — acceptance: 0 failures (covers: S2)
