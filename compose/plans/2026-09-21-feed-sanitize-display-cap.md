# Feed XML Harden + Display Cap 25 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RSS ingest resilient to malformed XML entities (P0 AI News failures), raise **non-research** per-category display cap from 15 to 25, and surface display caps in the shared-window UI.

**Architecture:** Task 1 adds `lib/feed-xml.mjs` (fetch → sanitize bare `&` → `parseString`). Task 2 flips `PAGE_MAX_PER_CATEGORY` only. Task 3 adds one Metro meta line under the Shared window heading so caps are policy-visible, not a hidden truncate. No governance/rules/pipeline-logic changes beyond feed parse.

**Tech Stack:** Node 20 ESM, existing `rss-parser`, `node:test`.

## Global Constraints

- **Confirmed (user 2026-09-21):** `PAGE_MAX_RESEARCH` stays **10**; research must remain tighter than other categories
- `PAGE_MAX_PER_CATEGORY` becomes **25** and applies to **non-research** categories only (industry, policy, tools-oss, model-releases, uncategorized)
- `FEED_MAX_NEW_PER_RUN` stays **30** (ingest cap unrelated to display)
- No personalization / ranking behavior changes
- Decision schema / audit trail untouched
- `npm test` must pass after each task
- Node built-in `fetch` only (already used in `lib/llm.mjs` / `lib/github.mjs`)
- Push to `main` does **not** trigger `content-pipeline` — verify via manual dispatch after merge

---

## File Structure

| File | Role |
|---|---|
| `lib/feed-xml.mjs` | **Create.** `sanitizeRssXml(xml)`, `fetchFeedText(url, opts)` |
| `test/feed-xml.test.mjs` | **Create.** Unit tests for sanitize + entity edge cases |
| `scripts/pipeline.mjs` | **Modify.** Use fetch+sanitize+parseString instead of `parser.parseURL` |
| `lib/constants.mjs` | **Modify.** `PAGE_MAX_PER_CATEGORY = 25` (research unchanged) |
| `test/constants-hash.test.mjs` | **Modify.** Expect 25 / research still 10 / research < per-category |
| `package.json` | **Modify.** `"test": "node --test test/"` so both test files run |
| `scripts/build-pages.mjs` | **Modify (Task 3).** Caps meta line under Shared window + small CSS |

---

### Task 1: Sanitize feed XML before parse (P0)

**Covers:** P0 — AI News `Invalid character in entity name`; any source with bare `&`

**Files:**
- Create: `lib/feed-xml.mjs`
- Create: `test/feed-xml.test.mjs`
- Modify: `scripts/pipeline.mjs` (feed fetch loop ~123–163)
- Modify: `package.json` test script

**Interfaces:**
- Consumes: Node 20 global `fetch`; existing `rss-parser` instance in pipeline
- Produces:
  - `sanitizeRssXml(xml: string): string`
  - `fetchFeedText(url: string, opts?: { timeoutMs?: number, userAgent?: string }): Promise<string>`

- [ ] **Step 1: Write failing tests**

Create `test/feed-xml.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeRssXml } from "../lib/feed-xml.mjs";

test("sanitizeRssXml escapes bare ampersands", () => {
  const bad = "<title>Manufacturing & Engineering AI</title>";
  assert.equal(sanitizeRssXml(bad), "<title>Manufacturing &amp; Engineering AI</title>");
});

test("sanitizeRssXml keeps valid entities", () => {
  const ok = '<a href="x?a=1&amp;b=2">&#8217; &#x2019; &lt;ok&gt;</a>';
  assert.equal(sanitizeRssXml(ok), ok);
});

test("sanitizeRssXml handles query-like bare ampersand", () => {
  const bad = "<link>https://example.com/p?utm_source=AI-News&utm_medium=x</link>";
  assert.equal(
    sanitizeRssXml(bad),
    "<link>https://example.com/p?utm_source=AI-News&amp;utm_medium=x</link>",
  );
});

test("sanitizeRssXml is idempotent", () => {
  const once = sanitizeRssXml("A & B");
  assert.equal(sanitizeRssXml(once), once);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/feed-xml.test.mjs
```

Expected: FAIL — `Cannot find module ... lib/feed-xml.mjs`

- [ ] **Step 3: Implement `lib/feed-xml.mjs`**

```javascript
/**
 * Fetch RSS/XML ourselves so we can repair common malformations
 * before rss-parser/sax (Invalid character in entity name).
 */

const DEFAULT_UA = "AICanonFeed/0.1 (+https://github.com/larrymou/aicanonfeed)";

/** Escape & that are not already a valid XML entity reference. */
export function sanitizeRssXml(xml) {
  return String(xml ?? "").replace(
    /&(?!#\d{1,7};|#x[0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,7};)/g,
    "&amp;",
  );
}

export async function fetchFeedText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 25000;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`feed timeout: ${url}`)), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": userAgent, accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}: ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run sanitize tests to verify they pass**

```bash
node --test test/feed-xml.test.mjs
```

Expected: PASS (4 tests)

- [ ] **Step 5: Point pipeline at fetch+sanitize+parseString**

In `scripts/pipeline.mjs`:

1. Change import:

```javascript
import { urlHash, loadSeenHashes, appendIndex } from "../lib/hash.mjs";
import { fetchFeedText, sanitizeRssXml } from "../lib/feed-xml.mjs";
```

2. Replace the per-feed parse block (currently `Promise.race` + `parser.parseURL`) with:

```javascript
      const xml = sanitizeRssXml(await fetchFeedText(feed.url, { timeoutMs: 25000 }));
      const parsed = await parser.parseString(xml);
```

Remove the old `Promise.race` / `parser.parseURL(feed.url)` / inner `setTimeout` reject for feed timeout if no longer used. Keep the surrounding `try/catch` that logs `[pipeline] feed fail ${feed.name}: ...`.

- [ ] **Step 6: Widen test runner**

`package.json` scripts.test:

```json
"test": "node --test test/"
```

- [ ] **Step 7: Run full tests**

```bash
npm test
```

Expected: all tests PASS (old constants + new feed-xml). Constants cap test still expects 15 until Task 2.

- [ ] **Step 8: Commit**

```bash
git add lib/feed-xml.mjs test/feed-xml.test.mjs scripts/pipeline.mjs package.json
git commit -m "fix: sanitize RSS XML before parse to stop entity failures"
```

---

### Task 2: Raise non-research per-category display cap to 25 (P1)

**Covers:** P1 — non-research tiles (industry / policy / tools-oss / model-releases) hidden by `PAGE_MAX_PER_CATEGORY=15`. **Research display cap is not changed** (`PAGE_MAX_RESEARCH=10`).

**Files:**
- Modify: `lib/constants.mjs:52`
- Modify: `test/constants-hash.test.mjs:45-49`

**Interfaces:**
- Consumes: `PAGE_MAX_PER_CATEGORY`, `PAGE_MAX_RESEARCH` from `lib/constants.mjs`
- Produces: display selection in `scripts/build-pages.mjs` `loadIncluded()` — **no cap-logic change required**; it already reads these constants (`cap = research ? PAGE_MAX_RESEARCH : PAGE_MAX_PER_CATEGORY`)

- [ ] **Step 1: Update the display-cap test first (red)**

In `test/constants-hash.test.mjs`, replace:

```javascript
test("display caps keep research tighter than other categories", () => {
  assert.ok(PAGE_MAX_RESEARCH < PAGE_MAX_PER_CATEGORY);
  assert.equal(PAGE_MAX_RESEARCH, 10);
  assert.equal(PAGE_MAX_PER_CATEGORY, 15);
});
```

with:

```javascript
test("display caps keep research tighter than other categories", () => {
  assert.ok(PAGE_MAX_RESEARCH < PAGE_MAX_PER_CATEGORY);
  assert.equal(PAGE_MAX_RESEARCH, 10);
  assert.equal(PAGE_MAX_PER_CATEGORY, 25);
});
```

- [ ] **Step 2: Run tests — expect FAIL on cap assertion**

```bash
npm test
```

Expected: FAIL — `PAGE_MAX_PER_CATEGORY` expected 25, got 15 (unless Task 2 constant already flipped; if so this step is the green check)

- [ ] **Step 3: Change the constant**

In `lib/constants.mjs`:

```javascript
export const PAGE_MAX_PER_CATEGORY = 25;
export const PAGE_MAX_RESEARCH = 10;
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

Expected: all PASS

- [ ] **Step 5: Rebuild page locally (sanity)**

```bash
node scripts/build-pages.mjs
```

Expected: write succeeds; if local `decisions/` has industry includes, up to 25 non-research industry tiles may appear.

- [ ] **Step 6: Commit**

```bash
git add lib/constants.mjs test/constants-hash.test.mjs
git commit -m "feat: raise per-category display cap from 15 to 25"
```

---

### Task 3: Surface display caps under Shared window (UI)

**Covers:** Transparency for Task 2 — readers can see why a category stops at 25 / research at 10 without treating the feed as a ranking.

**Placement decision (locked):**

| Location | Choice | Why |
|---|---|---|
| **Shared window heading** (`#latest` `.block-head`) | **Yes — primary** | Sits where truncation is felt; one Metro dim line; always on, not only when capped |
| LIVE status strip (hero) | **No** | Status stays operational: Live · window · count · stage/quorum |
| Tab labels (`industry 25/25`) | **No** | Reads like engagement quota; pollutes pivot; counts already show what’s on page |
| Contract chips (01–04) | **No** | Keep 4 chips; avoid densifying the already-sparse header |
| About section bullet | **Already mentions** research cap — leave as-is (out of scope to rewrite) |

**Copy (fixed):**

`Display caps · 25 per category · research 10 · balance by policy`

Constants interpolated: `PAGE_MAX_PER_CATEGORY` and `PAGE_MAX_RESEARCH` (no hardcoding 25/10 in HTML strings).

**Files:**
- Modify: `scripts/build-pages.mjs` — CSS (`.block-meta`) + `#latest` HTML

**Interfaces:**
- Consumes: `PAGE_MAX_PER_CATEGORY`, `PAGE_MAX_RESEARCH` (already imported in `build-pages.mjs`)
- Produces: rendered line in `docs/index.html` under `<h2 class="block-title">Shared window</h2>`

- [ ] **Step 1: Add CSS** in the Metro `/* —— Sections —— */` area after `.block-title { ... }`:

```css
  .block-meta {
    margin: 0.35rem 0 0;
    color: var(--dim);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
```

- [ ] **Step 2: Insert meta line** in the `#latest` section, immediately after the `block-head` closing div:

```javascript
    <section class="block" id="latest" aria-label="Latest included">
      <div class="block-head">
        <h2 class="block-title">Shared window</h2>
      </div>
      <p class="block-meta">Display caps · ${PAGE_MAX_PER_CATEGORY} per category · research ${PAGE_MAX_RESEARCH} · balance by policy</p>
      <div class="rail-wrap">
```

Ensure `PAGE_MAX_PER_CATEGORY` and `PAGE_MAX_RESEARCH` are in the existing import from `../lib/constants.mjs` (they already are at lines 16–17).

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: PASS (no test asserts on `.block-meta`; constants tests unchanged)

- [ ] **Step 4: Rebuild and grep generated HTML**

```bash
node scripts/build-pages.mjs
rg -n "Display caps" docs/index.html
```

Expected: one hit, e.g. `Display caps · 25 per category · research 10 · balance by policy`

- [ ] **Step 5: Commit**

```bash
git add scripts/build-pages.mjs
git commit -m "ui: show display caps under shared window heading"
```

---

## Out of Scope

- “N more not shown” dynamic truncation counts (deferred; always-on policy line covers transparency)
- R1 rule change for media-only model launches (governance, not code)
- Replacing AI News URL / removing the source (sanitize covers the failure mode; source stays)
- Changing `PAGE_MAX_RESEARCH`, ingest caps, or window length
- LLM title/link truncation (not requested this round)
- Rewording the About bullet that already mentions research caps

## Verification After All Tasks

```bash
npm test
node scripts/build-pages.mjs
node -e 'import("./lib/constants.mjs").then(m=>console.log(m.PAGE_MAX_PER_CATEGORY,m.PAGE_MAX_RESEARCH))'
# expect: 25 10

# P0 integration — live AI News path (or local bad-& fixture)
node -e '
import("rss-parser").then(async ({default: Parser}) => {
  const { fetchFeedText, sanitizeRssXml } = await import("./lib/feed-xml.mjs");
  const url = "https://www.artificialintelligence-news.com/feed/";
  const xml = sanitizeRssXml(await fetchFeedText(url));
  const r = await new Parser().parseString(xml);
  if (!r.items?.length) throw new Error("no items after sanitize");
  console.log("AI News OK", r.items.length, "items");
});
'

# generated page shows caps line
rg -n "Display caps|PAGE|research 10" docs/index.html
```

**Post-merge (required):** push `main` → `gh workflow run content-pipeline.yml` → confirm logs have **no** `feed fail AI News` (or fewer entity failures) → `gh workflow run build-pages.yml` → Pages.

## UI note — where display caps appear

See Task 3. Policy line lives **under the Shared window heading**, not in the LIVE status strip.

## Self-Review

- Spec coverage: P0 sanitize → Task 1; P1 cap 25 (non-research) → Task 2; UI caps disclosure → Task 3
- `PAGE_MAX_RESEARCH=10` locked in Global Constraints + Task 2 Covers + Task 3 copy
- No placeholders; code blocks complete
- Type consistency: `sanitizeRssXml` / `fetchFeedText` match pipeline; Task 3 interpolates constants, no magic numbers in HTML
- Integration + post-merge pipeline dispatch documented
- Placement rationale recorded (heading yes; status/tabs/chips no)

## Execution Handoff

Global memory: `execution-style: subagent`. Three tasks, sequential → implement with **compose:subagent** (fresh implementer per task) when executing.
