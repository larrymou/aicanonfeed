# Contributing

## Language

All product surfaces are **English**: rules, proposals, issue comments from the bot, and the Pages site.

## Propose a rule

1. Open a **Rule Proposal** issue and pick the template for your type (**New** / **Amend** / **Revoke**).
2. **Proposal Type** is pre-filled by the template:
   - `new` — add a rule item to an **existing** group (`## Target Group` = group number, e.g., `3`). MVP does not create new groups.
   - `amend` — **replace** rule text for an existing rule (`## Target Rule` = `group-item`, e.g., `3-1`)
   - `revoke` — mark the target rule `status: revoked` (`## Target Rule` = `group-item`)
3. Fill the target field in your template: **New** → `## Target Group`; **Amend** / **Revoke** → `## Target Rule`. The unused target field is not in the template.
4. Rule IDs use `<group>-<item>` format: `1-0` = group definition, `1-1` = first rule in group 1. Item numbers auto-increment and are never reused after deletion.
5. Suggested issue title: `[RULE] <type> <target>` (e.g. `[RULE] amend 3-1`). Templates pre-fill the prefix.
6. Write a complete, executable inclusion determination. For `amend`, paste the **full new rule text**, not a diff. For `revoke`, write the public justification (min 20 chars).
7. **Proposal quota:** at most **1 open** proposal and **1 new proposal per UTC day** per author. Extra filings are closed in pre-review. While repo stars are **< 100**, `FOUNDER_LOGIN` is exempt (same star gate as F1) so cold-start can exercise the loop.
8. The next governance cycle runs AI pre-review against meta-rules M1–M7.
9. If it passes, the issue is labeled `voting`. React 👍 or 👎.
10. The following cycle settles the vote. If ratified, a bot PR updates the rule file.

**Timeline:** expect about 8–14 days from proposal to an active rule (shorter when the founder casting vote applies — see Vote).

## Vote

- Only issues labeled `voting` count.
- One user, one vote: duplicate 👍 reactions count once; 👍 and 👎 together is a **void** vote.
- Author and bots are excluded. Accounts must be **≥ 30 days old** for a vote to count (`MIN_ACCOUNT_AGE_DAYS`).
- **Ties are defeated** (need `up > down` after quorum).
- Quorum counts **👍 only** (`up >= quorum`); 👎 cannot help meet quorum. It scales with stars as `min(25, max(3, floor(2*log2(stars+1))-7))` (see README) and **never drops below 3** (cap 25). **Experimental:** community proposals cannot change quorum or other voting mechanics (M5) — only maintainers editing `lib/constants.mjs`.
- **Vote deadline:** the next governance **settle run** (Mon 03:00 UTC). Reactions after that are not counted. Quorum and F1 stars are **frozen when the proposal enters `voting`** (`starsAtVotingStart` / `quorumAtVotingStart` in `decisions/rule-snapshots/`).
- **Auto-merge** needs **≥ 200 stars** (`AUTO_MERGE_MIN_STARS`); below that a maintainer merges rule PRs.
- **Founder seat (F1):** while starsAtVotingStart **&lt; 100**, `FOUNDER_LOGIN` (see `lib/constants.mjs`) may 👍 as a casting vote that can ratify without public quorum. 👎/void does not cast. At **≥ 100 stars** F1 is inactive. Settlement audits `founderVote` in `decisions/`. Vote detail (who voted how) is written to public `decisions/` — treat GitHub reactions as public ballots.

## Maintainers

- You may edit `feeds.json` directly via PR (no community source governance in MVP).
- Add `do-not-merge` on a bot rule PR to block auto-merge (kill switch). Auto-merge also requires **≥ 200 stars**.
- Create labels listed in `.github/LABELS.md` before first production run.

## Report a bad AI decision

File an issue describing the content URL and which rule you think should change. Do not edit `rules/` unless you are applying a ratified PR.
