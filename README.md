# AICanonFeed

**A CANON experiment:** an AI editor you can audit — not a feed that learns your clicks.

> **Experimental project — first live CANON instance.** Expect rough edges; audits live in `decisions/`. Inclusion rules already change through community Issues + votes. Voting and filing parameters (quorum formula, F1, auto-merge stars, proposal quota, …) are **code-locked for now** while the loop is validated; the direction is to put more of those knobs to community votes as CANON matures. Maintainers may still change thresholds in code during this phase.

**AICanonFeed** is the first live instance of the [**CANON** paradigm](https://github.com/larrymou/canon): constituents legislate, AI agents execute only ratified rules, the platform stays neutral, and every action is on the record.

## Why this exists

Three failures we are designing against:

1. **AI recommendation builds filter bubbles.** Engagement-optimized feeds learn your clicks and quietly narrow what you see. Personalization is the product; the bubble is the side effect.
2. **Human curation is opaque and subjective.** Editorial picks often rest on unwritten taste and shifting standards. Readers cannot inspect the rule that included a story — only the outcome, and the editor’s reputation.
3. **CANON is the third path — and this repo is its proof.** Rules are legislated in public (Issues + votes), an **AI editor** applies only what was ratified, and every include/reject lands in [`decisions/`](./decisions). Not “trust the model” and not “trust the desk” — trust the process.

Applied here: an **AI editor** in the seat recommendation algorithms usually take — bound by **community-ratified rules**, running on **GitHub**, producing **one shared edition for everyone**. Rules, a shared window, and a public audit trail instead of clicks, profiles, and black boxes.

**CANON (paradigm):** [github.com/larrymou/canon](https://github.com/larrymou/canon) — five pillars and structural constraints.  
**This repo (instance):** the community legislates (Issues + votes), AI adjudicates only by enacted rules, and GitHub executes — every call auditable in [`decisions/`](./decisions).

## The contract (anti–filter-bubble)

1. **Same edition for everyone** — one shared, chronological window (not a personal feed); no per-user state
2. **Rules, not recommendations** — inclusion only under ratified rules; no click model
3. **Zero engagement signals** — no ranking by popularity, dwell time, or “for you”
4. **Auditable** — every include/reject is a file in `decisions/` (with prompt version + ruleset fingerprint); rules are public git. **Fingerprint** = stable hash of active rule texts at decision time; **prompt version** = the pipeline/pre-review prompt revision. Both pin each judgment to the rules and prompt that produced it.
5. **Balance by policy** — category/source caps at ingest and display, so one track cannot flood the page

AI here is an **editor**, not a recommender: it selects under public rules, it does not predict what you will click.

**Designed forward.** The shared window is the last **5** days (`CONTENT_MAX_AGE_DAYS`). Rules and quotas evolve through CANON; we do not retrofit history — past `decisions/` keep the rules in force when they were made (`effective_at` / `version` on each rule file).

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

**This is an experimental CANON instance.** Quorum formula, floor/cap, F1, auto-merge stars, and proposal quota are **code constants** and **cannot be changed by community proposals yet** (meta-rule M5). Only maintainers change them in `lib/constants.mjs`. That lock is temporary while the mechanism is validated — **more parameters are meant to become voteable later** (for example daily proposal counts or quorum size). Inclusion rules in `rules/` already legislate through the proposal loop.

### Founder casting vote (F1)

While `starsAtVotingStart` is **&lt; 200**, the founder login (`lib/constants.mjs` → `FOUNDER_LOGIN`) may 👍 a `voting` issue as a **casting vote**: settlement may ratify even when public quorum is not met. (Author/bot rules unchanged — when the founder is the issue author they are excluded from the public tally like any author.) 👎 or void from the founder does **not** cast. Settlement records `founderVote` / `founderLogin` in `decisions/rule-reviews/` and in the Issue/PR text. Per-voter detail in `decisions/` is public.

At **≥ 200 stars**, F1 turns off (same gate as auto-merge); normal quorum (approve-count) and majority apply. Below **200 stars**, rule PRs still need a human merge.

### Audit trail map (`decisions/`)

| Path | What it records |
| ---- | --------------- |
| `content-reviews/` | Per-item include/reject with rule id + reason |
| `rule-reviews/pre-review-*.json` | AI pre-review verdict per proposal |
| `rule-reviews/settlement-*.json` | Vote tally, `founderVote`, outcome |
| `rule-reviews/recover-*.json` | Pending-merge reconciliation after a rule PR |
| `rule-reviews/cycle-summary-*.json` | One governance run summary |
| `rule-snapshots/<issue>.json` | Frozen proposal fields + quorum at voting entry |
| `index.jsonl` | Content ingest index (dedupe) |
| `errors/` | Pipeline/tooling errors |

## Participate

- Open a **Rule Proposal** issue (template). English, actionable inclusion text only.
- **Proposal types:** `new` (add item to an existing group via `## Target Group`), `amend` (full replacement text + `## Target Rule`), `revoke` (deactivate target; justification in Rule Text → `revoked_reason`; **original body kept**). MVP does not create new groups. Group definitions (`x-0`) can also be amended/revoked.
- **Proposal quota:** 1 open proposal and 1 new proposal per UTC day per author (a filing rejected or closed the same day **still consumes** that day's slot). While stars are **< 200**, `FOUNDER_LOGIN` is exempt (same star gate as F1 / auto-merge).
- **After `voting`:** do **not** edit the issue body — fields are snapshotted; later edits fail settlement (`rejected_by_guard`).
- **Rule text length:** ≤ 1500 chars (items) / ≤ 500 (group defs). **M2** requires defined, objective triggers — see CONTRIBUTING.
- Vote on issues labeled `voting` with 👍 / 👎. Authors and bots do not count in the public tally. Duplicate reactions count once; 👍+👎 together is a void. **Ties are defeated.** Votes close at the next settle run; accounts must be ≥ 30 days old.
- Under **&lt; 200 stars**, the founder may cast a single ratify vote (see F1 above).
- Rules take effect only after vote settlement + PR merge (about **1–2 weeks** on the public schedule; maintainers may run cycles early via `workflow_dispatch`).

See [CONTRIBUTING.md](./CONTRIBUTING.md).

**Meta-rules M1–M7** gate every proposal (form complete, objectively checkable, no spam/abuse, no constitutional edits, neutral, anti-personalization). Plain-language table in [CONTRIBUTING](./CONTRIBUTING.md); full text in [`lib/meta-rules.md`](./lib/meta-rules.md).

## Site

GitHub Pages shows the **editorial contract**, **Latest Included**, **Open for Vote**, **Active Rules**.

## Maintain

Workflows:

- `content-pipeline` — every 4 hours
- `governance-cycle` — Monday 03:00 UTC (settle then pre-review)
- `build-pages` — after either of the above

Maintainers may `workflow_dispatch` any workflow to run early.

### Content / display parameters (`lib/constants.mjs`)

| Constant | Value | Role |
| -------- | ----- | ---- |
| `CONTENT_MAX_AGE_DAYS` | 5 | Shared rolling window |
| `PAGE_MAX_PER_CATEGORY` | 25 | Display cap (non-research) |
| `PAGE_MAX_RESEARCH` | 10 | Tighter research cap |
| `FEED_MAX_NEW_PER_RUN` | 30 | Ingest ceiling per pipeline run |
| `RESEARCH_RUN_SHARE_MAX` | 0.5 | Research share of a run |
| `DEFAULT_SOURCE_MAX_PER_RUN` | 12 | Per-source ingest cap |
| `SUMMARY_MAX_CHARS` | 280 | Tile summary length |

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
