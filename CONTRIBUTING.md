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
4. Rule IDs use `<group>-<item>` format: `1-0` = group definition, `1-1` = first rule in group 1. Item numbers auto-increment and are never reused after deletion. **Group definitions (`x-0`) can be amended or revoked** like any other rule; `new` only adds items to an existing group.
5. Suggested issue title: `[RULE] <type> <target>` (e.g. `[RULE] amend 3-1`). Templates pre-fill the prefix.
6. Write a complete, executable inclusion determination. For `amend`, paste the **full new rule text**, not a diff. For `revoke`, write the public justification (min 20 chars) — the original rule body is kept and the justification is stored as `revoked_reason`.
   - **Length:** item rules ≤ **1500** chars; group definitions (`x-0`) ≤ **500** chars (`RULE_MAX_CHARS` / `RULE_MAX_CHARS_GROUP`).
   - **Metadata on amend/revoke:** `effective_at` is preserved; `version` increments; `amended_at` (or `revoked_at`) is set to the settlement date.
7. **Proposal quota:** at most **1 open** proposal and **1 new proposal per UTC day** per author. Extra filings are closed in pre-review. **A filing that is rejected or closed still consumes that UTC day's slot.** While repo stars are **< 200**, `FOUNDER_LOGIN` is exempt (same star gate as F1) so cold-start can exercise the loop.
8. The next governance cycle runs AI pre-review against meta-rules M1–M7 (hard shape/quota gates first, then LLM). If the LLM call fails, the proposal stays in `proposal` and is **retried next cycle** (not rejected).
9. If it passes, the issue is labeled `voting`. React 👍 or 👎.
10. The following cycle settles the vote. If ratified, a bot PR updates the rule file.

### Meta-rules (M1–M7) in plain words

Full text: [`lib/meta-rules.md`](./lib/meta-rules.md). These judge the **proposal**, not individual news items.

| ID | Name | What it means when you file |
| -- | ---- | --------------------------- |
| **M1** | Form | Write a complete include/exclude rule an AI can run and a human can audit — not a slogan or a wish. |
| **M2** | Unambiguous | Use objectively checkable conditions (named entity, named action, link class, or a number). Bare “reputable”, “major”, “good news” fail unless you define them. |
| **M3** | Anti-spam | No ads, self-promo, unrelated meta-talk, or resubmitting a near-copy of something already rejected. |
| **M4** | Safety | No hate incitement, targeted harassment, or clearly unlawful calls to action. |
| **M5** | Boundary | Do not rewrite the constitution: meta-rules, the five fixed categories, the shared-window display method, the GitHub account system, or voting mechanics (quorum, F1, auto-merge, proposal quota). |
| **M6** | Neutrality | Do not order the editor to favor or punish specific companies, people, or viewpoints (narrow factual scope is fine). |
| **M7** | Anti-personalization | No “for you”, engagement ranking, click models, or interest profiles — one shared rule-based edition only. |

### Writing rule text that can pass (M2)

M2 rejects **undefined** subjectivity, not every judgment. Use this shape:

1. **Structural triggers** — checkable from title/summary/URL (named entity, named action, link class).
2. **Defined terms** — define fuzzy words in the rule itself (“major version” = owner labels it major, or `N.0`).
3. **Bounded residual judgment** — if an editor call remains, state what is judged and how ties break (“official link wins over media repost”).

Avoid bare “reputable”, “material”, “major”, “appropriate”, “good news” without a definition. Seed rules in `rules/` predate this bar; new proposals (and amends of seeds) must meet it.

### After your proposal enters `voting`

- **Do not edit the issue body.** Type, targets, category, and Rule Text are snapshotted (`decisions/rule-snapshots/`). Body edits after pre-review fail settlement with `rejected_by_guard`.
- Comment freely; only the frozen fields matter.
- Votes close at the **next settle run** — reactions after that are ignored.

**Timeline:** expect about 8–14 days from proposal to an active rule on the public schedule (shorter when the founder casting vote applies — see Vote). Maintainers may trigger `governance-cycle` / `build-pages` via `workflow_dispatch` to accelerate a cycle.

## Vote

- Only issues labeled `voting` count.
- **One user, one vote:** duplicate 👍 count once; 👍 **and** 👎 together is a **void** vote (not counted).
- **Author and bots are excluded** from the public tally. Accounts must be **≥ 30 days old** for a vote to count (`MIN_ACCOUNT_AGE_DAYS`); unknown ages are not counted (fail-closed).
- **Ties are defeated** (need `up > down` after quorum).
- Quorum counts **👍 only** (`up >= quorum`); 👎 cannot help meet quorum. It scales with stars as `min(25, max(3, floor(2*log2(stars+1))-7))` (see README) and **never drops below 3** (cap 25). **Experimental lock (temporary):** community proposals cannot change quorum, proposal quota, or other voting mechanics yet (M5) — only maintainers editing `lib/constants.mjs`. More of these parameters are expected to open to community votes later as CANON matures.
- **Pass condition:** `up >= quorum` **and** `up > down`.
- **Vote deadline:** the next governance **settle run** (Mon 03:00 UTC on the public schedule). Reactions after that are not counted. Quorum and F1 stars are **frozen when the proposal enters `voting`** (`starsAtVotingStart` / `quorumAtVotingStart` in `decisions/rule-snapshots/`). Live stars only affect auto-merge.
- **Auto-merge** needs **≥ 200 stars** (`AUTO_MERGE_MIN_STARS`); below that a maintainer merges rule PRs.
- **Founder seat (F1):** while starsAtVotingStart **&lt; 200**, `FOUNDER_LOGIN` (see `lib/constants.mjs`) may 👍 as a casting vote that can ratify **without** public quorum. Only a clean 👍 casts — 👎 or a void (👍+👎) does not. When the founder is the **issue author**, they are still excluded from the public tally, but F1 still applies. At **≥ 200 stars** F1 is inactive (same gate as auto-merge). Settlement audits `founderVote` in `decisions/`. Vote detail (who voted how) is written to public `decisions/` — treat GitHub reactions as public ballots.

## Maintainers

- You may edit `feeds.json` directly via PR (no community source governance in MVP).
- Add `do-not-merge` on a bot rule PR to block auto-merge (kill switch). Auto-merge also requires **≥ 200 stars**.
- Create labels listed in `.github/LABELS.md` (including `ratified_pending_merge`) before first production run.
- **Cycles:** `content-pipeline` every 4 hours; `governance-cycle` Monday 03:00 UTC; `build-pages` after either. Use `workflow_dispatch` to run any of them early (e.g. settle a vote the same day). After merging a rule PR, run `build-pages` if you need the site updated before the next scheduled build.

## Report a bad AI decision

File an issue describing the content URL and which rule you think should change. Do not edit `rules/` unless you are applying a ratified PR.
