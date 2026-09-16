# AICanonFeed

**A CANON experiment:** an AI editor you can audit — not a feed that learns your clicks.

> **Experimental project.** Governance thresholds, sources, and automation are expected to change. Expect rough edges; audits live in `decisions/`.

**AICanonFeed** puts an **AI editor** in the seat recommendation algorithms usually take — bound by **community-ratified rules**, running on **GitHub**, producing **one shared edition for everyone**. Those algorithms optimize clicks and quietly build filter bubbles; this project does the opposite: rules, a shared window, and a public audit trail.

**CANON:** the community legislates (Issues + votes), AI adjudicates only by enacted rules, and GitHub executes — every call auditable in `decisions/`.

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

## Cold-start quorum

Quorum never goes below **3**.

| Stars | Valid votes required (quorum) |
| ----- | ----------------------------- |
| < 200 | 3 |
| 200–999 | 5 |
| ≥ 1000 | `max(3, floor(stars/100)+1)` |

Stage is evaluated at settlement time from the repository star count. Thresholds are code constants (`lib/constants.mjs`) and cannot be changed by proposals (meta-rule M5). At **S0**, ratified rule PRs are **not auto-merged** — a maintainer must merge.

## Participate

- Open a **Rule Proposal** issue (template). English, actionable inclusion text only.
- Vote on issues labeled `voting` with 👍 / 👎. Authors cannot count their own reactions.
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
