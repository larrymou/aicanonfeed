# Contributing

## Language

All product surfaces are **English**: rules, proposals, issue comments from the bot, and the Pages site.

## Propose a rule

1. Open a **Rule Proposal** issue.
2. Write a complete, executable inclusion determination (or keep it rejected under meta-rules).
3. The next governance cycle runs AI pre-review against meta-rules M1–M6.
4. If it passes, the issue is labeled `voting`. React 👍 or 👎.
5. The following cycle settles the vote. If ratified, a bot PR adds a rule file and merges it.

**Timeline:** expect about 8–14 days from proposal to an active rule.

## Vote

- Only issues labeled `voting` count.
- One user: 👍 and 👍 is one up-vote; 👍 and 👎 together is a **void** vote.
- Author and bots are excluded.
- Quorum depends on repository stars (see README). Stage S0 still needs **at least one non-author 👍**.

## Maintainers

- You may edit `feeds.json` directly via PR (no community source governance in MVP).
- Add `do-not-merge` on a bot rule PR to block auto-merge (kill switch).
- Create labels listed in `.github/LABELS.md` before first production run.

## Report a bad AI decision

File an issue describing the content URL and which rule you think should change. Do not edit `rules/` unless you are applying a ratified PR.
