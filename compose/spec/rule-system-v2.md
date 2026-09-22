---
feature: rule-system-v2
status: delivered
updated: 2026-09-22
branch: main
commits: 588bd22..HEAD
---

# Rule System V2 — Group + Item

## Report

**What was built** — Rule system redesigned from `R#` flat format to `<group>-<item>` hierarchy. Groups (`x-0`) define categories (dynamic, not hardcoded); items (`x-y`) are inclusion rules. Version history via `version`/`amended_at` frontmatter. Migrated R1-R5 → 1-0/1-1 through 5-0/5-1. UI shows groups with nested items. `SAFE_RULE_PATH` updated to `rules/\d+-\d+\.md`.

**Verification** — `npm test` → 44/44 pass. `node --check` on governance/pipeline/build-pages all clean.

**Journey log** — `loadActiveRules` returns `{groups, items}` not `{active}`. `rulesForPrompt` now takes `(groups, items)`. `nextFreeRuleId` replaced by `nextFreeItemNumber`/`nextFreeGroupNumber`. `CATEGORIES` still hardcoded as fallback but groups drive dynamic tabs.

## [S1] Problem

Current rule system uses `R1`–`R5` with hardcoded 5 categories. Problems:
1. One rule per category (convention), no support for multiple rules in same category
2. No rule version history — cannot see what changed
3. Categories are fixed constants — adding a rule does not add a category
4. Rule IDs (`R#`) do not encode group/item hierarchy
5. `RULE_MAX_CHARS = 800` too tight for nuanced rules

## [S2] Design

### ID format: `<group>-<item>`

| ID | Meaning |
|---|---|
| `1-0` | Group 1 definition (category name, label, description) |
| `1-1` | Group 1, item 1 (first rule) |
| `1-2` | Group 1, item 2 (second rule) |
| `2-0` | Group 2 definition |
| … | … |

- Item numbers auto-increment within a group (start from 1)
- Deleted item numbers are **never reused**
- Group numbers auto-increment (start from 1)
- `RULE_ID_RE = /^\d+-\d+$/`

### Rule file format

**Group definition (`1-0.md`):**
```markdown
---
id: 1-0
type: group
status: active
source: seed
category: model-releases
name: Model Releases
effective_at: 2026-09-22
amended_at: null
version: 1
---

# Model Releases

This group covers new AI models, major versions, and capability announcements.
```

**Item (`1-1.md`):**
```markdown
---
id: 1-1
type: item
group: 1
status: active
source: seed
category: model-releases
effective_at: 2026-09-22
amended_at: null
version: 1
---

Include only items that announce a new AI model from the model owner...
```

### Category derivation

- **Groups define categories** — `CATEGORIES` becomes dynamic (derived from active groups)
- `TAB_ORDER` becomes dynamic (sorted by group number)
- Each group's `category` field is the tab slug; `name` is the tab label
- Adding a new group automatically adds a new tab/category
- Display caps (`PAGE_MAX_PER_CATEGORY`, `PAGE_MAX_RESEARCH`) apply per group/category

### Version history

- `version: N` in frontmatter (incremented on each amend)
- `amended_at: ISO timestamp` when amended
- Full history readable from `git log -- rules/1-1.md`
- No separate history directory (use git)

### Governance (amend/revoke)

- `## Target Rule` = `1-2` (item) or `1-0` (group)
- `new` proposal: `## Target Group` = `1` (add item to group 1)
  - If `## Target Group` empty/absent → create new group (group definition + optional initial item)
- `amend`: full replacement text; `version` incremented; `amended_at` set
- `revoke`: `status: revoked`; deleted numbers never reused
- `nextFreeItemNumber(groupId)` = max existing item + 1 (or 1 if none)
- `nextFreeGroupNumber()` = max existing group + 1

### File naming

`rules/<group>-<item>.md` — e.g., `rules/1-0.md`, `rules/1-2.md`
- `SAFE_RULE_PATH` regex: `/^rules\/\d+-\d+\.md$/`

### Rule text limits

- Item: `RULE_MAX_CHARS = 1500`
- Group: `RULE_MAX_CHARS_GROUP = 500`

### Migration (R1–R5 → V2)

| Old | New |
|---|---|
| R1-model-releases.md | `1-0.md` (group) + `1-1.md` (item) |
| R2-research.md | `2-0.md` + `2-1.md` |
| R3-industry.md | `3-0.md` + `3-1.md` |
| R4-policy.md | `4-0.md` + `4-1.md` |
| R5-tools-oss.md | `5-0.md` + `5-1.md` |

Migration script converts frontmatter and body. Old `R#` references in decisions are historical (not migrated).

### AI editor prompt

```
## Rules

### Group 1: Model Releases (model-releases)
- 1-1: Include only items that announce a new AI model...

### Group 2: Research (research)
- 2-1: Include items that report new AI research papers...
```

AI returns `matchedRuleId: "1-1"` (item ID). `categoryId` forced from the group's `category`.

### UI/UX

- Tabs = active groups (dynamic, not hardcoded)
- Rules page shows groups with items nested under each group
- Version number displayed on each rule
- `Display caps · 25 per category · research 10 · balance by policy` unchanged

## [S3] Out of Scope

- Rule priority/ordering within a group (first match wins)
- Rule merge/split operations
- Rule approval workflow changes (same governance process)
- Category rename after group creation
- Rule text word count changes beyond 1500/500

## Tasks

- [ ] T1: Update `lib/constants.mjs` — remove hardcoded CATEGORIES, add RULE_ID_RE for `x-y`, RULE_MAX_CHARS=1500, RULE_MAX_CHARS_GROUP=500 — acceptance: constants export correct values (covers: S2)
- [ ] T2: Rewrite `lib/rules.mjs` — new loadActiveRules (groups+items), findRuleFile by `x-y`, nextFreeItemNumber, nextFreeGroupNumber, buildRuleFile with type/version — acceptance: unit tests pass (covers: S2)
- [ ] T3: Update `lib/github.mjs` SAFE_RULE_PATH regex — acceptance: `rules/1-0.md` passes, `rules/R1-model-releases.md` fails (covers: S2)
- [ ] T4: Update `scripts/governance.mjs` — parseTargetRule as `x-y`, handle new/amend/revoke with group/item, version increment — acceptance: governance logic compiles, unit tests pass (covers: S2)
- [ ] T5: Update `scripts/pipeline.mjs` — matchedRuleId validation with `x-y` format — acceptance: pipeline accepts `1-1`, rejects `R1` (covers: S2)
- [ ] T6: Update `scripts/build-pages.mjs` — dynamic tabs from groups, rules page shows groups+items with version — acceptance: page renders groups and items (covers: S2)
- [ ] T7: Migrate existing R1-R5 → 1-0/1-1, 2-0/2-1, … — acceptance: 5 groups + 5 items created, content preserved (covers: S2)
- [ ] T8: Update `.github/ISSUE_TEMPLATE/rule-proposal.md` + CONTRIBUTING.md — acceptance: docs match new ID format (covers: S2)
- [ ] T9: Update tests + `npm test` all green — acceptance: 0 failures (covers: S2)
