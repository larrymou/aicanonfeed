# Metro Shared-Window UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the generated AICanonFeed page as a Metro (flat tile) shared-window UI.

**Architecture:** Single-file template rewrite inside `scripts/build-pages.mjs`. Keep data pipeline, tab filter JS, and a11y semantics; replace CSS tokens, header/status, pivot tabs, and feed markup from list-rows to a mixed-size tile grid.

**Tech Stack:** Node ESM, inline CSS in generated HTML, no new deps.

## Global Constraints

- Keep dark color-scheme; no personalization/ranking behavior changes
- 5-day window copy stays accurate; “shared window” narrative, not “daily edition”
- Square corners, no drop shadows, no decorative gradients on tiles
- Tab filter JS must still work (`data-tab`, `data-category`, `#empty-filter`)
- `npm test` must stay green (14/14)
- Generate via `node scripts/build-pages.mjs` and inspect `docs/index.html`

---

### Task 1: Metro tokens + header/status strip

**Files:** Modify `scripts/build-pages.mjs` (CSS `:root`/body/hero, header HTML)

- [ ] Replace tokens with Metro palette (`#0a0a0a` bg, `#1a1a1a` tiles, `#0078d4` accent, `#00d4aa` live)
- [ ] Compact hero: wordmark light/heavy, lede, LIVE status line (window · count · S0/quorum)
- [ ] Collapse contract cards to one horizontal chip row
- [ ] Keep skip link + focus-visible rings

### Task 2: Pivot tabs + tile grid feed

**Files:** Modify `scripts/build-pages.mjs` (`.rail`/`.tab`, `.item`, feed HTML)

- [ ] Pivot-style lowercase tabs with underline active state
- [ ] `#feed` as CSS grid (4→2→1 columns); tiles square-cornered
- [ ] `model-releases` items get `tile-wide` (span 2) + solid accent surface
- [ ] Why details stay, restyled square; research title slightly smaller
- [ ] Filter JS keeps working; empty states preserved

### Task 3: Secondary sections + build verify

**Files:** Modify `scripts/build-pages.mjs` (vote/rules/about/footer CSS)

- [ ] Restyle vote/rules/about to flat rows (no soft radius cards)
- [ ] Run `npm test` and `node scripts/build-pages.mjs`
- [ ] Spot-check generated `docs/index.html` for Metro classes and no old gradient hero
