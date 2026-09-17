#!/usr/bin/env node
/**
 * Build static GitHub Pages site: Latest Included first, then Open for Vote, Rules, About.
 * Visual direction: editorial dark — minimal chrome, hairline list, calm type scale.
 */
import fs from "node:fs";
import path from "node:path";
import {
  SUMMARY_MAX_CHARS,
  stageForStars,
  LABELS,
  CONTENT_MAX_AGE_DAYS,
  CATEGORIES,
  TAB_ORDER,
  isCategory,
  PAGE_MAX_PER_CATEGORY,
  PAGE_MAX_RESEARCH,
} from "../lib/constants.mjs";
import { loadActiveRules } from "../lib/rules.mjs";
import { listOpenIssuesWithLabel, listIssueReactions, getRepo } from "../lib/github.mjs";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "docs");

function log(...args) {
  console.log("[build-pages]", ...args);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url) {
  const u = String(url || "").trim();
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

function loadIncluded() {
  const dir = path.join(ROOT, "decisions", "content-reviews");
  if (!fs.existsSync(dir)) return [];
  const maxAgeMs = CONTENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const rows = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (obj.include !== true) continue;
      const t = new Date(obj.pubDate || obj.decidedAt || 0).getTime();
      if (!Number.isFinite(t) || now - t > maxAgeMs) continue;
      rows.push(obj);
    } catch {
      /* skip */
    }
  }
  rows.sort((a, b) => {
    const ta = new Date(a.pubDate || a.decidedAt || 0).getTime();
    const tb = new Date(b.pubDate || b.decidedAt || 0).getTime();
    return tb - ta;
  });
  // Per-category display caps: research tighter so one track cannot own the window.
  const byCat = new Map();
  const picked = [];
  for (const r of rows) {
    const cat = isCategory(r.categoryId) ? r.categoryId : "uncategorized";
    const cap = cat === "research" ? PAGE_MAX_RESEARCH : PAGE_MAX_PER_CATEGORY;
    const n = byCat.get(cat) || 0;
    if (n >= cap) continue;
    byCat.set(cat, n + 1);
    picked.push(r);
  }
  return picked;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function tallyDisplayVotes(reactions, authorLogin) {
  const byUser = new Map();
  for (const r of reactions) {
    const login = r.user?.login;
    if (!login || login.toLowerCase() === String(authorLogin || "").toLowerCase()) continue;
    if (/\[bot\]$/i.test(login)) continue;
    if (!byUser.has(login)) byUser.set(login, new Set());
    byUser.get(login).add(r.content);
  }
  let up = 0;
  let down = 0;
  for (const set of byUser.values()) {
    const hasUp = set.has("+1");
    const hasDown = set.has("-1");
    if (hasUp && hasDown) continue;
    if (hasUp) up++;
    else if (hasDown) down++;
  }
  return { up, down };
}

function categoryName(slug) {
  return CATEGORIES[slug] || slug || "";
}

function tabLabel(id) {
  if (id === "all") return "All";
  return CATEGORIES[id] || id;
}

function shortLabel(slug) {
  const map = {
    "model-releases": "Models",
    research: "Research",
    industry: "Industry",
    policy: "Policy",
    "tools-oss": "Tools",
  };
  return map[slug] || categoryName(slug);
}

async function main() {
  const { active: rules } = loadActiveRules(path.join(ROOT, "rules"));
  const included = loadIncluded();
  // No hardcoded fallback — wrong owner/name is worse than missing links.
  const repoSlugEnv =
    process.env.GITHUB_REPOSITORY ||
    process.env.GH_REPO ||
    process.env.REPO_SLUG ||
    null;
  const gh = (suffix = "") =>
    repoSlugEnv ? `https://github.com/${repoSlugEnv}${suffix}` : null;
  const proposeHref = () => gh("/issues/new/choose");
  const proposeHtml = (label = "Propose a rule") => {
    const href = proposeHref();
    return href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label);
  };
  /** Inline GitHub link; falls back to plain text when repo slug is unknown. */
  const ghLink = (suffix, label) => {
    const href = gh(suffix);
    return href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label);
  };
  /** Parent CANON paradigm repo (separate from this instance). */
  const CANON_PARADIGM = "https://github.com/larrymou/canon";
  const ghCanon = (label = "github.com/larrymou/canon") =>
    `<a href="${CANON_PARADIGM}">${esc(label)}</a>`;

  const counts = { all: included.length };
  for (const id of Object.keys(CATEGORIES)) counts[id] = 0;
  for (const r of included) {
    const id = r.categoryId;
    if (id && isCategory(id)) counts[id]++;
  }

  let stars = 0;
  let stageInfo = stageForStars(0);
  let votingHtml = '<p class="empty">Voting data unavailable (local build without token).</p>';

  try {
    const repo = await getRepo();
    stars = repo.stargazers_count || 0;
    stageInfo = stageForStars(stars);
    const voting = await listOpenIssuesWithLabel(LABELS.voting);
    const items = [];
    for (const issue of voting) {
      let up = 0;
      let down = 0;
      try {
        const reactions = await listIssueReactions(issue.number);
        const t = tallyDisplayVotes(reactions, issue.user?.login);
        up = t.up;
        down = t.down;
      } catch {
        /* ignore */
      }
      const need = Math.max(0, stageInfo.quorum - (up + down));
      const needText =
        up + down < stageInfo.quorum
          ? `${need} more vote${need === 1 ? "" : "s"} needed · quorum ${stageInfo.quorum}`
          : up > down
            ? "Leading"
            : "Tied or behind";
      items.push(`<li class="vote-item">
        <a class="vote-title" href="${esc(issue.html_url)}">${esc(issue.title)}</a>
        <div class="vote-meta"><span>👍 ${up} · 👎 ${down}</span><span>${esc(needText)}</span></div>
      </li>`);
    }
    votingHtml = items.length
      ? `<ul class="list vote-list">${items.join("\n")}</ul>`
      : `<p class="empty"><strong>No open proposals.</strong> Ratified rules only change through Issues. ${proposeHtml()}</p>`;
  } catch (err) {
    log("GitHub unavailable:", String(err.message || err));
    votingHtml =
      '<p class="empty"><strong>Voting data unavailable.</strong> Local build without a GitHub token. On the live site this lists issues labeled <code>voting</code>.</p>';
    stageInfo = stageForStars(stars);
  }

  const tabsHtml = TAB_ORDER.map((id, i) => {
    const n = counts[id] ?? 0;
    const active = i === 0 ? " is-active" : "";
    return `<button type="button" class="tab${active}" data-tab="${esc(id)}" aria-pressed="${i === 0 ? "true" : "false"}">${esc(tabLabel(id).toLowerCase())}<span class="count">${n}</span></button>`;
  }).join("");

  const feedHtml = included.length
    ? included
        .map((r) => {
          const href = safeHref(r.url);
          const title = esc(r.title);
          const titleHtml = href
            ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${title}</a>`
            : `<span class="plain">${title}</span>`;
          const cat = isCategory(r.categoryId) ? r.categoryId : "";
          const isResearch = cat === "research";
          const rule = r.matchedRuleId || "";
          const summary = (r.summary || "").slice(0, isResearch ? 140 : SUMMARY_MAX_CHARS);
          const date = fmtDate(r.pubDate || r.decidedAt || "");
          const wide = cat === "model-releases" ? " tile-wide" : "";
          const solid = cat === "model-releases" ? " tile-solid" : "";
          return `<article class="tile${wide}${solid}${isResearch ? " is-research" : ""}" data-category="${esc(cat)}">
  <div class="tile-meta">
    <span class="cat cat-${esc(cat)}">${esc(cat ? shortLabel(cat) : "Uncategorized")}</span>
    <span class="src">${esc(r.sourceName || "")}</span>
    <span class="rule-tag"><a href="#rule-${esc(rule)}">${esc(rule || "")}</a></span>
  </div>
  <h3 class="tile-title">${titleHtml}</h3>
  <p class="tile-summary">${esc(summary)}</p>
  <div class="tile-foot">
    <time datetime="${esc(r.pubDate || r.decidedAt || "")}">${esc(date)}</time>
    ${r.reason ? `<details class="tile-why"><summary>Why</summary><p class="why-reason">Matched <code>${esc(rule || "?")}</code>${r.ruleFingerprint ? ` · ruleset <code>${esc(r.ruleFingerprint)}</code>` : ""} — ${esc(String(r.reason).slice(0, 300))}</p></details>` : ""}
  </div>
</article>`;
        })
        .join("\n")
    : `<p class="empty" data-category="all"><strong>Empty window.</strong> Nothing included in the last ${CONTENT_MAX_AGE_DAYS} days. The pipeline runs every 4 hours — check Active rules for what the editor is allowed to pick.</p>`;

  const rulesHtml = rules
    .map(
      (r) => `<li class="rule-row" id="rule-${esc(r.id)}">
  <div class="rule-head">
    <span class="rule-id">${esc(r.id)}</span>
    <span class="cat cat-${esc(r.category)}">${esc(shortLabel(r.category))}</span>
  </div>
  <p class="rule-body">${esc(r.body)}</p>
  <p class="rule-cta">${proposeHtml("Propose a change")}</p>
</li>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="AICanonFeed — first live CANON instance: one shared AI-news window. Community rules + an AI editor. No personalization. No ranking.">
<meta name="color-scheme" content="dark">
<title>AICanonFeed · AI editor, not a recommender</title>
<style>
  /* Metro shared-window — flat tiles, square, high contrast */
  :root {
    --bg: #0a0a0a;
    --bg-deep: #000000;
    --ink: #ffffff;
    --muted: #9a9a9a;
    --dim: #6e6e6e;
    --line: #2a2a2a;
    --line-soft: #1f1f1f;
    --accent: #0078d4;
    --accent-soft: #6a9fff;
    --live: #00d4aa;
    --tile: #1a1a1a;
    --max: 68rem;
    --tag-model: #7aa2ff;
    --tag-industry: #5ecf9a;
    --tag-policy: #e0b35e;
    --tag-tools: #9b8cff;
    --tag-research: #4fc3f7;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 3.5rem; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 300 16px/1.55 "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    min-height: 100%;
  }
  a { color: var(--ink); text-decoration: none; }
  a:hover { color: var(--accent-soft); }
  a:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .plain { color: inherit; }
  .skip {
    position: absolute;
    left: -9999px;
    top: 0;
    z-index: 100;
    padding: 0.65rem 1rem;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .skip:focus { left: 0; color: #fff; }

  .wrap {
    width: min(100% - 3rem, var(--max));
    margin-inline: auto;
  }

  /* —— Header / live status —— */
  .hero {
    padding: 2.75rem 0 0.75rem;
  }
  .wordmark {
    margin: 0;
    font-size: clamp(1.85rem, 3.6vw, 2.35rem);
    font-weight: 200;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .wordmark span {
    color: var(--ink);
    font-weight: 600;
  }
  .lede {
    margin: 0.85rem 0 0;
    max-width: 38rem;
    color: var(--muted);
    font-size: 1rem;
    line-height: 1.65;
  }
  .lede strong { color: var(--ink); font-weight: 600; }

  .status {
    margin: 1.35rem 0 0;
    color: var(--muted);
    font-size: 0.78rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.1rem;
    align-items: center;
  }
  .status .live-dot {
    width: 8px;
    height: 8px;
    background: var(--live);
    display: inline-block;
  }
  .status .live-label {
    color: var(--live);
    font-weight: 700;
  }
  .status strong { color: #fff; font-weight: 600; text-transform: none; letter-spacing: 0; font-size: 1rem; margin-right: -0.35rem; }
  .status .sep { display: none; }
  .status .gov { color: var(--accent-soft); }

  .contract {
    margin: 1.25rem 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    max-width: none;
    border: 0;
  }
  .contract-item {
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--dim);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .contract-item .t { display: inline; font-weight: 400; color: var(--muted); font-size: inherit; letter-spacing: inherit; }
  .contract-item .d { display: none; }
  .contract-item .n { display: inline; margin: 0 0.35rem 0 0; color: var(--accent); font-size: inherit; }
  .contract-item code { display: none; }

  .hero-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0;
    margin: 1.5rem 0 0;
    padding: 0 0 0.35rem;
    border-bottom: 1px solid var(--line-soft);
    font-size: 0.95rem;
  }
  .hero-nav a {
    color: var(--muted);
    padding: 0.75rem 1.1rem;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    font-weight: 300;
  }
  .hero-nav a:hover { color: #fff; background: #141414; }

  /* —— Sections —— */
  main { padding: 2.25rem 0 5rem; }
  .block { margin-top: 4rem; }
  .block:first-child { margin-top: 1.25rem; }
  .block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.35rem;
  }
  .block-title {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* —— Pivot tabs —— */
  .rail-wrap {
    position: sticky;
    top: 0;
    z-index: 20;
    margin: 0 0 1.5rem;
    padding-top: 0.5rem;
    background: rgba(10, 10, 10, 0.94);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .rail {
    display: flex;
    flex-wrap: nowrap;
    gap: 0;
    margin: 0;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .rail::-webkit-scrollbar { display: none; }
  .tab {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--dim);
    font: inherit;
    font-size: 0.95rem;
    font-weight: 300;
    text-transform: lowercase;
    padding: 0.9rem 1.15rem 0.7rem;
    cursor: pointer;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
    min-height: 44px;
    white-space: nowrap;
  }
  .tab:hover { color: #fff; }
  .tab:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
  .tab.is-active {
    color: #fff;
    font-weight: 600;
    border-bottom-color: var(--accent);
  }
  .tab .count {
    margin-left: 0.35rem;
    color: inherit;
    opacity: 0.7;
    font-size: 0.8em;
    font-variant-numeric: tabular-nums;
  }

  /* —— Tile grid —— */
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  #feed {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-auto-rows: minmax(13rem, auto);
    gap: 1.15rem;
  }
  .tile {
    background: var(--tile);
    border: 1px solid var(--line-soft);
    padding: 1.35rem 1.35rem 1.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    min-height: 13rem;
    transition: background 0.12s ease;
  }
  .tile:hover { background: #202020; }
  .tile.is-hidden { display: none !important; }
  .tile-wide { grid-column: span 2; min-height: 14rem; }
  .tile-solid {
    background: var(--accent);
    border-color: var(--accent);
  }
  .tile-solid:hover { background: #1a86d8; }
  .tile-solid .tile-title,
  .tile-solid .tile-title a { color: #fff; }
  .tile-solid .tile-summary,
  .tile-solid .tile-meta,
  .tile-solid .tile-foot,
  .tile-solid .tile-foot time { color: rgba(255, 255, 255, 0.85); }
  .tile-solid .cat {
    background: rgba(0, 0, 0, 0.25);
    border-color: rgba(255, 255, 255, 0.35);
    color: #fff;
  }
  .tile-solid .rule-tag a { color: rgba(255, 255, 255, 0.9); border-color: rgba(255,255,255,0.3); }
  .tile-solid .tile-why summary { color: rgba(255, 255, 255, 0.9); }
  .tile-solid .why-reason {
    background: rgba(0, 0, 0, 0.25);
    border-left-color: #fff;
    color: rgba(255, 255, 255, 0.9);
  }

  .tile-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.65rem;
    font-size: 0.7rem;
    color: var(--dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .cat {
    display: inline-flex;
    align-items: center;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-size: 0.68rem;
    font-weight: 700;
  }
  .cat::before { content: none; }
  .cat-model-releases { color: var(--tag-model); }
  .cat-research { color: var(--tag-research); }
  .cat-industry { color: var(--tag-industry); }
  .cat-policy { color: var(--tag-policy); }
  .cat-tools-oss { color: var(--tag-tools); }
  .src { color: inherit; font-weight: 400; text-transform: none; letter-spacing: 0; }
  .rule-tag { margin-left: auto; }
  .rule-tag a {
    color: var(--muted);
    font-size: 0.72rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 0 0.3rem;
    border: 1px solid var(--line);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
  .rule-tag a:hover { color: #fff; border-color: #fff; }

  .tile-title {
    margin: 0.15rem 0 0;
    font-size: 1.08rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.35;
    flex: 1;
  }
  .tile-wide .tile-title { font-size: 1.22rem; line-height: 1.3; }
  .tile.is-research .tile-title { font-size: 1rem; font-weight: 600; }
  .tile-title a { color: #fff; }
  .tile-title a:hover { color: var(--accent-soft); }
  .tile-title a[target="_blank"]::after {
    content: " ↗";
    font-size: 0.7em;
    color: var(--dim);
  }
  .tile-title a[target="_blank"]:hover::after { color: var(--accent-soft); }

  .tile-summary {
    margin: 0;
    color: var(--muted);
    font-size: 0.88rem;
    line-height: 1.55;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tile-wide .tile-summary { -webkit-line-clamp: 4; font-size: 0.95rem; }

  .tile-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-top: auto;
    padding-top: 0.75rem;
    border-top: 1px solid var(--line-soft);
    font-size: 0.75rem;
    color: var(--dim);
  }
  .tile-why { font-size: 0.8rem; }
  .tile-why summary {
    color: var(--accent-soft);
    cursor: pointer;
    list-style: none;
    min-height: 1.75rem;
    display: inline-flex;
    align-items: center;
    font-weight: 600;
  }
  .tile-why summary::-webkit-details-marker { display: none; }
  .tile-why summary::before { content: "+ "; font-weight: 700; }
  .tile-why[open] summary::before { content: "− "; }
  .tile-why summary:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .why-reason {
    margin: 0.45rem 0 0.25rem;
    color: var(--muted);
    padding: 0.55rem 0.7rem;
    border-left: 2px solid var(--accent);
    background: #111;
    line-height: 1.5;
  }
  .why-reason code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    color: var(--accent-soft);
  }
  .empty {
    color: var(--muted);
    padding: 1.5rem 0.15rem;
    max-width: 36rem;
    line-height: 1.55;
  }
  .empty strong { color: #fff; font-weight: 600; }

  /* —— Vote —— */
  .vote-list li {
    padding: 1.25rem 0;
    border-bottom: 1px solid var(--line-soft);
  }
  .vote-title {
    display: block;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .vote-meta {
    margin-top: 0.3rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    color: var(--muted);
    font-size: 0.875rem;
  }

  /* —— Rules —— */
  .rule-row {
    padding: 1.4rem 0;
    margin: 0;
    border-bottom: 1px solid var(--line-soft);
    list-style: none;
  }
  ul.rules { margin: 0; padding: 0; }
  .rule-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .rule-id {
    font-weight: 700;
    letter-spacing: 0.04em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    color: var(--accent-soft);
  }
  .rule-body {
    margin: 0.4rem 0 0;
    color: #fff;
    max-width: 42rem;
  }
  .rule-cta {
    margin: 0.45rem 0 0;
    font-size: 0.875rem;
  }
  .rule-cta a { color: var(--muted); }
  .rule-cta a:hover { color: #fff; }

  /* —— About / footer —— */
  .about p,
  .about li {
    color: var(--muted);
    max-width: 40rem;
  }
  .about ul {
    margin: 0.5rem 0 1rem;
    padding-left: 1.1rem;
  }
  .about li { margin: 0.35rem 0; }
  .canon {
    margin: 0.5rem 0 1.75rem;
    padding: 0;
    border: 0;
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    max-width: none;
  }
  .canon-step {
    background: var(--tile);
    border: 1px solid var(--line-soft);
    padding: 1.25rem 1.2rem;
  }
  .canon-step .n {
    display: block;
    color: var(--accent);
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }
  .canon-step .t {
    color: #fff;
    font-weight: 600;
    font-size: 0.98rem;
  }
  .canon-step .d {
    color: var(--muted);
    font-size: 0.85rem;
    margin-top: 0.2rem;
  }
  .how {
    margin: 0 0 0.9rem;
    max-width: 40rem;
    color: var(--muted);
  }
  .how strong { color: #fff; font-weight: 600; }
  .how a {
    color: var(--accent-soft);
  }
  .how a:hover { color: #fff; }
  .canon-step .d a {
    color: var(--accent-soft);
  }
  .canon-step .d a:hover { color: #fff; }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1.1rem;
    font-size: 0.92rem;
  }
  .links a { color: var(--muted); }
  .links a:hover { color: #fff; }
  footer {
    padding: 0 0 3rem;
    color: var(--dim);
    font-size: 0.78rem;
    letter-spacing: 0.02em;
  }
  footer code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85em;
  }
  footer .tag { color: var(--accent-soft); font-weight: 700; letter-spacing: 0.08em; }
  :target { scroll-margin-top: 3.5rem; }

  @media (max-width: 960px) {
    #feed { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  }
  @media (max-width: 640px) {
    .wrap { width: min(100% - 1.5rem, var(--max)); }
    #feed { grid-template-columns: 1fr; gap: 0.9rem; }
    .tile { min-height: 0; padding: 1.15rem 1.1rem 1rem; }
    .tile-wide { grid-column: span 1; min-height: 0; }
    .canon { grid-template-columns: 1fr; gap: 0.75rem; }
    .tab { padding-inline: 0.85rem; font-size: 0.9rem; }
    .hero { padding-top: 1.75rem; }
    main { padding-top: 1.5rem; }
    .block { margin-top: 2.75rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .tile { transition: none; }
  }
</style>
</head>
<body>
  <a class="skip" href="#latest">Skip to latest</a>
  <header class="hero">
    <div class="wrap">
      <h1 class="wordmark">AICanon<span>Feed</span></h1>
      <p class="lede">One shared AI-news window for everyone. A community-ratified rulebook decides inclusion; an <strong>AI editor</strong> applies it — no personalization, no engagement ranking, every call auditable on GitHub.</p>
      <p class="status" aria-label="Shared window status">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="live-label">Live</span>
        <span>Shared window · last ${CONTENT_MAX_AGE_DAYS} days</span>
        <strong>${esc(included.length)}</strong>
        <span>included</span>
        <span class="gov">${esc(stageInfo.stage)} · quorum ${esc(stageInfo.quorum)} · ${esc(stars)}★</span>
      </p>
      <div class="contract" role="list" aria-label="Editorial contract">
        <div class="contract-item" role="listitem"><span class="n">01</span><span class="t">Same window</span><p class="d">One shared rolling window — not a personal feed.</p></div>
        <div class="contract-item" role="listitem"><span class="n">02</span><span class="t">Rules not recs</span><p class="d">Inclusion only under ratified rules.</p></div>
        <div class="contract-item" role="listitem"><span class="n">03</span><span class="t">Zero engagement</span><p class="d">No popularity rank or “for you”.</p></div>
        <div class="contract-item" role="listitem"><span class="n">04</span><span class="t">Auditable</span><p class="d">Every decision is a public file in decisions/.</p></div>
      </div>
      <nav class="hero-nav" aria-label="Sections">
        <a href="#latest">latest</a>
        <a href="#vote">vote</a>
        <a href="#rules">rules</a>
        <a href="#about">canon &amp; join</a>
      </nav>
    </div>
  </header>

  <main class="wrap" id="main">
    <section class="block" id="latest" aria-label="Latest included">
      <div class="block-head">
        <h2 class="block-title">Shared window</h2>
      </div>
      <div class="rail-wrap">
        <div class="rail" role="tablist" aria-label="Filter by category">
          ${tabsHtml}
        </div>
      </div>
      <div id="feed">
${feedHtml}
      </div>
      <p class="empty" id="empty-filter" hidden><strong>Nothing here.</strong> No items in this category for the last ${CONTENT_MAX_AGE_DAYS} days. Try all, or check back after the next pipeline run.</p>
    </section>

    <section class="block" id="vote">
      <div class="block-head">
        <h2 class="block-title">Open for vote</h2>
      </div>
      ${votingHtml}
    </section>

    <section class="block" id="rules">
      <div class="block-head">
        <h2 class="block-title">Active rules</h2>
      </div>
      <ul class="rules">
${rulesHtml}
      </ul>
    </section>

    <section class="block about" id="about">
      <div class="block-head">
        <h2 class="block-title">About · CANON</h2>
      </div>
      <p class="how"><strong>What this is</strong> — The first live <strong>CANON</strong> instance (${ghCanon()}): constituents legislate inclusion rules on ${ghLink("", "this repo")}, an <strong>AI editor</strong> applies only ratified rules, and GitHub publishes <strong>one shared 5-day window</strong> for everyone. Not a recommender.</p>
      <p class="how"><strong>Why</strong> — Recommendation feeds optimize clicks and quietly build filter bubbles. AICanonFeed sits in the opposite seat: rules instead of personalization, a shared record in ${ghLink("/tree/main/decisions", "decisions/")} instead of a black box. The product is designed forward — rules and quotas evolve; we do not rewrite history to match.</p>
      <p class="how"><strong>CANON</strong> (paradigm: ${ghCanon()}) in three steps here — community legislates on Issues, AI judges only by enacted rules, and GitHub (code + history) is the neutral executor.</p>
      <div class="canon" role="list">
        <div class="canon-step" role="listitem">
          <span class="n">01</span>
          <div class="t">Legislate</div>
          <div class="d">Open a rule proposal via ${proposeHtml("GitHub Issues")}. Bound by ${ghLink("/blob/main/lib/meta-rules.md", "meta-rules M1–M7")}.</div>
        </div>
        <div class="canon-step" role="listitem">
          <span class="n">02</span>
          <div class="t">Adjudicate</div>
          <div class="d">AI pre-reviews proposals and applies only ratified rules in ${ghLink("/tree/main/rules", "rules/")} — it never invents inclusion criteria.</div>
        </div>
        <div class="canon-step" role="listitem">
          <span class="n">03</span>
          <div class="t">Execute</div>
          <div class="d">Votes, PRs, and ${ghLink("/tree/main/decisions", "decisions/")} are public. No ranking, no pins — every inclusion can be audited.</div>
        </div>
      </div>
      <p class="how"><strong>How to join</strong> — ${proposeHtml("Propose a rule")}, vote 👍 / 👎 on ${ghLink("/labels/voting", "issues labeled voting")}, or audit calls under ${ghLink("/tree/main/decisions", "decisions/")}. Full guide: ${ghLink("/blob/main/CONTRIBUTING.md", "CONTRIBUTING.md")}. Rules take ~8–14 days.</p>
      <ul>
        <li>Strict reverse-chronological order. Tabs are filters, not rankings.</li>
        <li>Research is capped on ingest and again on the page so industry/policy/tools stay visible.</li>
        <li>Uncovered items are rejected by design.</li>
        <li>Meta-rule M7 forbids personalization: no per-user feeds, no engagement ranking.</li>
        <li>Rules change over time; past decisions keep the rule version in effect when they were made.</li>
      </ul>
      <p class="links">
        <a href="${CANON_PARADIGM}">CANON paradigm</a>
        ${gh() ? `<a href="${esc(gh())}">This instance</a>` : ""}
        ${gh("/blob/main/CONTRIBUTING.md") ? `<a href="${esc(gh("/blob/main/CONTRIBUTING.md"))}">Contributing</a>` : ""}
        ${gh("/blob/main/lib/meta-rules.md") ? `<a href="${esc(gh("/blob/main/lib/meta-rules.md"))}">Meta-rules</a>` : ""}
        ${gh("/tree/main/rules") ? `<a href="${esc(gh("/tree/main/rules"))}">Active rules source</a>` : ""}
        ${gh("/tree/main/decisions") ? `<a href="${esc(gh("/tree/main/decisions"))}">Decisions</a>` : ""}
        ${proposeHref() ? `<a href="${esc(proposeHref())}">Propose a rule</a>` : ""}
      </p>
    </section>
  </main>

  <footer class="wrap">
    <span class="tag">CANON</span>
    · first live instance of <a href="${CANON_PARADIGM}">github.com/larrymou/canon</a>
    · AI editor, not a recommender · auditable in <code>decisions/</code>.
  </footer>

<script>
(function () {
  var tabs = document.querySelectorAll('.tab');
  var items = document.querySelectorAll('#feed .tile, #feed .item');
  var empty = document.getElementById('empty-filter');
  var emptyAll = document.querySelector('#feed p.empty');

  function apply(id) {
    var visible = 0;
    items.forEach(function (el) {
      var cat = el.getAttribute('data-category') || '';
      var show = id === 'all' || cat === id;
      el.classList.toggle('is-hidden', !show);
      el.hidden = !show;
      if (show) visible++;
    });
    if (emptyAll) emptyAll.hidden = !(id === 'all' && visible === 0);
    if (empty) empty.hidden = !(id !== 'all' && visible === 0);
  }

  tabs.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabs.forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      var id = btn.getAttribute('data-tab');
      apply(id);
      if (history.replaceState) history.replaceState(null, '', '#' + id);
    });
  });

  var hash = (location.hash || '').replace('#', '');
  if (hash && document.querySelector('.tab[data-tab="' + hash + '"]')) {
    document.querySelector('.tab[data-tab="' + hash + '"]').click();
  }
})();
</script>
</body>
</html>
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "index.html");
  fs.writeFileSync(outFile, html, "utf8");
  log(`wrote ${outFile} (${included.length} items; research=${counts.research || 0})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
