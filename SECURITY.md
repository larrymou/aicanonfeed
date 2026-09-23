# Security & Operations (Public Repository)

AICanonFeed is a **public** GitHub repository. Automation uses `GITHUB_TOKEN` plus optional LLM API credentials. This document is the operational checklist for keeping keys and the supply chain safe.

## Secrets model

| Secret | Where | Purpose |
| ------ | ----- | ------- |
| `GITHUB_TOKEN` | Provided by Actions automatically | Issues, PRs, push, Pages deploy |
| `LLM_API_KEY` | Repository Actions secret | Content and rule AI calls |
| `LLM_BASE_URL` | Repository Actions secret | OpenAI-compatible API base |
| `LLM_MODEL` | Repository Actions secret | Model name |

**Rules**

- Never commit keys, `.env` files, or paste keys into issues, PRs, prompts, or README.
- Only store LLM credentials in **Settings → Secrets and variables → Actions**.
- Do not `echo` / `printenv` the full environment in workflows or scripts.
- Prefer a **dedicated** LLM key with a hard monthly spend limit and usage alerts (DeepSeek/OpenAI console).
- Rotate the key if logs, forks, or collaborators look wrong.

## What is safe in a public repo

| Pattern | Safe? |
| ------- | ----- |
| `${{ secrets.LLM_API_KEY }}` in `env:` for a scheduled job | Yes (normal MVP setup) |
| Key in source code or `feeds.json` | No |
| Actions log output of a failed curl that prints response only | Usually fine; avoid dumping request headers |
| `pull_request` workflows that receive secrets | Risky for untrusted PRs — **do not add** |
| `pull_request_target` + checkout of PR code + secrets | **Do not use** |

Scheduled `content-pipeline` / `governance-cycle` and `workflow_run` Pages builds do not run third-party PR code. Keep it that way.

## Workflow permissions

Each workflow should declare minimal permissions, for example:

- `content-pipeline`: `contents: write`, `issues: write`
- `governance-cycle`: `contents: write`, `issues: write`, `pull-requests: write`
- `build-pages`: `contents: write`

In **Settings → Actions → General**:

1. **Workflow permissions** → *Read and write permissions*
2. **Allow GitHub Actions to create and approve pull requests** → **enabled**  
   (required for bot rule PRs and auto-merge)

`GITHUB_TOKEN` is scoped to this repository and expires with the job (~1 hour). It is not a long-lived PAT.

## Supply chain (public repo + auto-merge)

- Rule PRs are constrained by path allowlist (`rules/*.md` only) and must pass code guards.
- Maintainer kill switch: label a bot PR **`do-not-merge`** to block auto-merge.
- Review any change to `.github/workflows/**` carefully before merging — workflows can read secrets on the next run.
- Prefer squash-merging bot PRs; do not run unsandboxed third-party Actions you do not trust (pin major versions you recognize).

## Cold-start founder seat (F1)

Under **&lt; 100 stars**, `FOUNDER_LOGIN` may cast one ratify vote on `voting` issues (F1). This exists so the project can exercise the full governance loop before a community forms; it is **not** a hidden override:

- Coded in `lib/constants.mjs` + `lib/voting.mjs` (not changeable by Rule Proposals — M5)
- Public tally still excludes the founder-as-author; F1 is separate from quorum math (approve-count)
- Every settlement writes `founderVote` / `founderLogin` into `decisions/rule-reviews/`
- S0 / stars **&lt; 200** still block auto-merge; a human must merge the rule PR
- Votes require account age ≥ 30 days (`MIN_ACCOUNT_AGE_DAYS`). Confirmed-too-young and unknown/lookup-failed are both not counted (fail-closed for auto-merge), but settlement and Pages report them separately (`droppedYoung` vs `droppedUnknown`).
- F1 deactivates automatically at **≥ 100 starsAtVotingStart** (frozen when the issue entered `voting`)
- Settlement JSON includes per-voter `detail` (login + vote) under public `decisions/` — GitHub reactions are public ballots, not a secret ballot
- F1 deactivates automatically at **≥ 100 stars**
- F1 deactivates automatically at **≥ 100 stars**

If the founder key/account is compromised while F1 is active, assume rule ratify is compromised until stars are audited and accounts rotated.

## Labels (create before first production run)

See [`.github/LABELS.md`](../.github/LABELS.md):

`proposal`, `voting`, `rejected`, `ratified`, `defeated`, `expired_no_quorum`, `do-not-merge`

## First-run checklist

1. Push default branch **`main`**.
2. Enable Actions read/write + PR creation.
3. Create labels.
4. Add `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`.
5. Enable Pages from branch **`gh-pages`** after the first successful `build-pages` run.
6. Trigger `content-pipeline` via **workflow_dispatch** and confirm decisions land in `decisions/`.

## Incident: key may be exposed

1. Revoke/rotate the LLM key in the provider console immediately.
2. Create a new repository secret; do not reuse the old value.
3. Check Actions runs and repository forks for unexpected workflow edits.
4. Review billing usage for unexpected spend.

## Out of scope for MVP

Multi-provider LLM failover and external audit logging are post-MVP (see product spec). Account-age vote filtering is implemented (`MIN_ACCOUNT_AGE_DAYS`) and required before auto-merge.
