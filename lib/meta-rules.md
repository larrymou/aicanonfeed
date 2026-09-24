# AICanonFeed Meta-Rules (M1–M7)

These constraints are **hard**. The content and governance AI must not invent rules beyond them, and community proposals that modify or circumvent them are rejected.

They judge **rule proposals** (Issues), not day-to-day news items. Plain-language summary is also in [CONTRIBUTING.md](../CONTRIBUTING.md).

| ID | Name | One-line |
| -- | ---- | -------- |
| M1 | Form | Complete, executable include/exclude determination |
| M2 | Unambiguous | Objectively verifiable conditions only |
| M3 | Anti-spam | No ads, self-promo, or identical resubmits |
| M4 | Safety | No hate, harassment, or unlawful calls to action |
| M5 | Boundary | No edits to meta-rules, fixed categories, display method, accounts, or voting mechanics |
| M6 | Neutrality | No favoring/targeting companies, people, or viewpoints |
| M7 | Anti-personalization | No per-user feeds or engagement ranking |

## M1 Form

A proposal must be a complete inclusion/exclusion determination that an AI can execute and a human can audit. Slogans, fragments, or non-actionable demands are rejected.

## M2 Unambiguous

Conditions must be objectively verifiable (specific entities, actions, sources, or quantitative thresholds). Vague terms such as "appropriate", "some", "in principle", or "good news" are rejected.

## M3 Anti-spam

Ads, self-promotion, content unrelated to AI-news inclusion, and resubmissions substantially identical to prior rejections are rejected.

## M4 Safety

Content must not include hate incitement, targeted harassment of individuals, or clearly unlawful calls to action.

## M5 Boundary

Proposals must not modify or circumvent hard constraints:

- **meta-rules** (this file) themselves
- **fixed categories** — the five slugs `model-releases`, `research`, `industry`, `policy`, `tools-oss` (and their display tabs)
- **display method** — one shared reverse-chronological window (`CONTENT_MAX_AGE_DAYS`), per-category / research display caps, no ranking
- **account system** — GitHub accounts as identity; `MIN_ACCOUNT_AGE_DAYS` for votes
- **voting mechanics** — quorum formula/thresholds, star stages, F1, auto-merge star gate, proposal quota

No content may claim exemption from review.

**Experimental lock (temporary):** while this mechanism is being validated, voting and filing parameters live only in code (`lib/constants.mjs`). Community proposals cannot amend them yet — only maintainers changing code can. This is a product experiment choice, not a permanent constitutional rule. The CANON direction of travel is to open more of these parameters to community legislation over time (for example daily proposal counts or quorum size) once the loop is trustworthy enough to amend itself.

## M6 Neutrality

Proposals must not instruct the content-moderation AI to favor or target specific companies, individuals, or viewpoints (factual scoping excepted).

## M7 Anti-personalization

Proposals must not introduce personalization or recommendation: per-user feeds, engagement-optimized ranking, click/dwell models, interest profiles, "for you" surfaces, or popularity scores. AICanonFeed serves one shared, rule-based edition; AI acts as an editor under public rules, not as a recommender of individuals.
