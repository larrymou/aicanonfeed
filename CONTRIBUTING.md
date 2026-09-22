# Contributing

## Language

All product surfaces are **English**: rules, proposals, issue comments from the bot, and the Pages site.

## Propose a rule

1. Open a **Rule Proposal** issue.
2. Set **Proposal Type**:
   - `new` — create a rule item in an existing group (specify `## Target Group`, e.g., `3`) or create a new group
   - `amend` — **replace** rule text for an existing rule (specify `## Target Rule`, e.g., `3-1`)
   - `revoke` — mark the target rule `status: revoked` (specify `## Target Rule`)
3. Rule IDs use `<group>-<item>` format: `1-0` = group definition, `1-1` = first rule in group 1. Item numbers auto-increment and are never reused after deletion.
4. Write a complete, executable inclusion determination. For `amend`, paste the **full new rule text**, not a diff.
5. The next governance cycle runs AI pre-review against meta-rules M1–M7.
6. If it passes, the issue is labeled `voting`. React 👍 or 👎.
7. The following cycle settles the vote. If ratified, a bot PR updates the rule file.

**Timeline:** expect about 8–14 days from proposal to an active rule (shorter when the founder casting vote applies — see Vote).

## Vote

- Only issues labeled `voting` count.
- One user: 👍 and 👍 is one up-vote; 👍 and 👎 together is a **void** vote.
- Author and bots are excluded.
- **Ties are defeated** (need `up > down` after quorum).
- Quorum depends on repository stars (see README) and **never drops below 3**. Stage S0 still requires maintainer merge (no auto-merge).
- **Founder seat (F1):** while stars **&lt; 100**, `FOUNDER_LOGIN` (see `lib/constants.mjs`) may 👍 as a casting vote that can ratify without public quorum. The founder remains excluded from the public tally; 👎/void does not cast. At **≥ 100 stars** F1 is inactive. Settlement audits `founderVote` in `decisions/`.

## Maintainers

- You may edit `feeds.json` directly via PR (no community source governance in MVP).
- Add `do-not-merge` on a bot rule PR to block auto-merge (kill switch). S0 also blocks auto-merge by default.
- Create labels listed in `.github/LABELS.md` before first production run.

## Report a bad AI decision

File an issue describing the content URL and which rule you think should change. Do not edit `rules/` unless you are applying a ratified PR.
