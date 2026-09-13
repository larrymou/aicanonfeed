# AICanonFeed

Community writes the rules. AI applies them. GitHub is the platform.

**CANON:** the community legislates (Issues + votes), AI adjudicates only by enacted rules, and GitHub executes — every call auditable in `decisions/`.

A chronological feed of AI news items that match **community-ratified inclusion rules**. There is no ranking, no manual pin, and no content outside rule coverage.

## Principles

1. **Time-ordered only** — reverse chronological, no algorithmic ranking
2. **Rules-only inclusion** — AI applies ratified rules; items with no matching rule are rejected
3. **No human content moderation** — the platform does not hand-review feed items
4. **Auditable** — Git history + Issues + `decisions/`

## How it works

```
Rule proposal (Issue) → AI pre-review → Community vote → PR merges rules/
                                                      ↓
RSS sources → dedupe → AI applies active rules → decisions/ + Latest Included page
```

## Cold-start quorum

| Stars | Valid votes required (quorum) |
| ----- | ----------------------------- |
| < 200 | 1 (must be a non-author 👍) |
| 200–999 | 5 |
| ≥ 1000 | `floor(stars/100)+1` (strictly >1% of stars) |

Stage is evaluated at settlement time from the repository star count. Thresholds are code constants (`lib/constants.mjs`) and cannot be changed by proposals (meta-rule M5).

## Participate

- Open a **Rule Proposal** issue (template). English, actionable inclusion text only.
- Vote on issues labeled `voting` with 👍 / 👎. Authors cannot count their own reactions.
- Rules take effect only after vote settlement + PR merge (plan for **1–2 weeks** end-to-end).

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Site

GitHub Pages shows **Latest Included**, **Open for Vote**, **Active Rules**.

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
