# AICanonFeed

**A CANON experiment:** an AI editor you can audit — not a feed that learns your clicks.

> **Experimental project.** Governance thresholds, sources, and automation are expected to change (maintainers only — community Rule Proposals cannot amend voting mechanics). Expect rough edges; audits live in `decisions/`.

**AICanonFeed** is the first live instance of the [**CANON** paradigm](https://github.com/larrymou/canon) — constituents legislate, AI agents execute only ratified rules, the platform stays neutral, and every action is on the record. Applied here: an **AI editor** in the seat recommendation algorithms usually take — bound by **community-ratified rules**, running on **GitHub**, producing **one shared edition for everyone**. Those algorithms optimize clicks and quietly build filter bubbles; this project does the opposite: rules, a shared window, and a public audit trail.

**CANON (paradigm):** [github.com/larrymou/canon](https://github.com/larrymou/canon) — five pillars and structural constraints.  
**This repo (instance):** the community legislates (Issues + votes), AI adjudicates only by enacted rules, and GitHub executes — every call auditable in [`decisions/`](./decisions).

## The contract (anti–filter-bubble)

1. **Same edition for everyone** — one shared, chronological window (not a personal feed); no per-user state
2. **Rules, not recommendations** — inclusion only under ratified rules; no click model
3. **Zero engagement signals** — no ranking by popularity, dwell time, or “for you”
4. **Auditable** — every include/reject is a file in `decisions/` (with prompt version + ruleset fingerprint); rules are public git
5. **Balance by policy** — category/source caps at ingest and display, so one track cannot flood the page

AI here is an **editor**, not a recommender: it selects under public rules, it does not predict what you will click.

**Designed forward.** The shared window is the last **5** days. Rules and quotas evolve through CANON; we do not retrofit history — past `decisions/` keep the rules in force when they were made.

## How it works

```
Rule proposal (Issue) → AI pre-review → Community vote → PR merges rules/
                                                      ↓
RSS sources → dedupe → AI applies active rules → decisions/ + Latest Included page
```

GitHub stays the platform: Issues legislate, Actions run the pipeline, Pages serve the edition, `decisions/` is the audit trail.

## Principles

1. **Time-ordered only** — reverse chronological, no algorithmic ranking
2. **Rules-only inclusion** — AI applies ratified rules; items with no matching rule are rejected
3. **No human content moderation** — the platform does not hand-review feed items
4. **No personalization** — the product never learns the individual reader
5. **Auditable** — Git history + Issues + `decisions/`

## Quorum

Quorum counts **approve votes only** (👍). Opponents cannot help a proposal meet quorum. It never drops below **3** and is capped at **25**. Stars are the electorate proxy on purpose — simple and public (this is an experiment, not a production voting system):

```
quorum = min(25, max(3, floor(2 * log2(stars + 1)) - 7))
```

| Stars | Approve votes required (quorum) |
| ----- | ------------------------------- |
| 0 | 3 |
| 100 | 6 |
| 1000 | 12 |
| 10000 | 19 |
| ≥ ~65k | 25 |

Pass = `up >= quorum` **and** `up > down`. Ties are defeated. Stage labels (display only): `< 200` → S0, `< 1000` → S1, else S2.

**Voting window.** Quorum and F1 use `starsAtVotingStart`, frozen when a proposal enters `voting` (see `decisions/rule-snapshots/`). **Votes close at the next settlement run** (Mon 03:00 UTC); later reactions do not count. Accounts must be **≥ 30 days old** to have a vote counted.

**Auto-merge** is a pure star gate (`AUTO_MERGE_MIN_STARS = 200` in `lib/constants.mjs`): below 200★ a maintainer must merge the rule PR; at ≥ 200★ the bot may auto-merge (unless labeled `do-not-merge`). Account-age filtering is always on so auto-merge is never open to brand-new accounts.

**This is an experimental project.** Quorum formula, floor/cap, F1, and auto-merge stars are **code constants** and **cannot be changed by community proposals** (meta-rule M5). Only maintainers can change them in `lib/constants.mjs`. The community cannot yet amend voting mechanics through the proposal loop — that lock is intentional while the mechanism is still being validated.

### Founder casting vote (F1)

While `starsAtVotingStart` is **&lt; 100**, the founder login (`lib/constants.mjs` → `FOUNDER_LOGIN`) may 👍 a `voting` issue as a **casting vote**: settlement may ratify even when public quorum is not met. (Author/bot rules unchanged — when the founder is the issue author they are excluded from the public tally like any author.) 👎 or void from the founder does **not** cast. Settlement records `founderVote` / `founderLogin` in `decisions/rule-reviews/` and in the Issue/PR text. Per-voter detail in `decisions/` is public.

At **≥ 100 stars**, F1 turns off; normal quorum (approve-count) and majority apply. Below **200 stars**, rule PRs still need a human merge.

## Participate

- Open a **Rule Proposal** issue (template). English, actionable inclusion text only.
- **Proposal types:** `new` (add item to an existing group via `## Target Group`), `amend` (full replacement text + `## Target Rule`), `revoke` (deactivate target; justification in Rule Text). MVP does not create new groups.
- **Proposal quota:** 1 open proposal and 1 new proposal per UTC day per author. While stars are **< 100**, `FOUNDER_LOGIN` is exempt (same star gate as F1).
- Vote on issues labeled `voting` with 👍 / 👎. Authors cannot count their own reactions. Duplicate reactions count once. **Ties are defeated.** Votes close at the next settle run; accounts must be ≥ 30 days old.
- Under **&lt; 100 stars**, the founder may cast a single ratify vote (see F1 above).
- Rules take effect only after vote settlement + PR merge (plan for **1–2 weeks** end-to-end).

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Site

GitHub Pages shows the **editorial contract**, **Latest Included**, **Open for Vote**, **Active Rules**.

## Maintain

Workflows:

- `content-pipeline` — every 4 hours
- `governance-cycle` — Monday 03:00 UTC
- `build-pages` — after either of the above

**Secrets, permissions, and public-repo hygiene:** see [SECURITY.md](./SECURITY.md).

Local scripts (Node 20+):

```bash
npm ci
npm run pipeline
npm run governance
npm run build-pages
```

## License

MIT
