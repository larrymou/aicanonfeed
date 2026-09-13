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
  return rows.slice(0, 100);
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
  const repoSlugEnv =
    process.env.GITHUB_REPOSITORY || process.env.GH_REPO || "larrymou/aicanonfeed";

  const counts = { all: included.length };
  for (const id of Object.keys(CATEGORIES)) counts[id] = 0;
  for (const r of included) {
    const id = r.categoryId;
    if (id && isCategory(id)) counts[id]++;
  }

  let stars = 0;
  let stageInfo = { stage: "S0", stars: 0, quorum: 1 };
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
      : '<p class="empty">No open proposals. <a href="https://github.com/' +
        esc(repoSlugEnv) +
        '/issues/new/choose">Propose a rule</a></p>';
  } catch (err) {
    log("GitHub unavailable:", String(err.message || err));
    stageInfo = stageForStars(process.env.STARS || 0);
  }

  const tabsHtml = TAB_ORDER.map((id, i) => {
    const n = counts[id] ?? 0;
    const active = i === 0 ? " is-active" : "";
    return `<button type="button" class="tab${active}" data-tab="${esc(id)}" aria-pressed="${i === 0 ? "true" : "false"}">${esc(tabLabel(id))}<span class="count">${n}</span></button>`;
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
          return `<article class="item${isResearch ? " is-research" : ""}" data-category="${esc(cat)}">
  <div class="item-kicker">
    <span class="cat cat-${esc(cat)}">${esc(cat ? shortLabel(cat) : "Uncategorized")}</span>
    <span class="dot" aria-hidden="true">·</span>
    <span class="src">${esc(r.sourceName || "")}</span>
    <span class="dot" aria-hidden="true">·</span>
    <time datetime="${esc(r.pubDate || r.decidedAt || "")}">${esc(date)}</time>
    <span class="rule-tag"><a href="#rule-${esc(rule)}">${esc(rule || "")}</a></span>
  </div>
  <h3 class="item-title">${titleHtml}</h3>
  <p class="item-summary">${esc(summary)}</p>
</article>`;
        })
        .join("\n")
    : `<p class="empty" data-category="all">Nothing included in the last ${CONTENT_MAX_AGE_DAYS} days.</p>`;

  const rulesHtml = rules
    .map(
      (r) => `<li class="rule-row" id="rule-${esc(r.id)}">
  <div class="rule-head">
    <span class="rule-id">${esc(r.id)}</span>
    <span class="cat cat-${esc(r.category)}">${esc(shortLabel(r.category))}</span>
  </div>
  <p class="rule-body">${esc(r.body)}</p>
  <p class="rule-cta"><a href="https://github.com/${esc(repoSlugEnv)}/issues/new/choose">Propose a change</a></p>
</li>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="AICanonFeed — community-written inclusion rules, AI-applied, chronological feed for AI industry and research.">
<meta name="color-scheme" content="dark">
<title>AICanonFeed</title>
<style>
  /* Deep blue system — minimal, modern */
  :root {
    --bg: #060b16;
    --bg-deep: #040812;
    --ink: #e8eef8;
    --muted: #8a96ab;
    --line: #17233a;
    --line-soft: #101a2e;
    --accent: #5b9dff;
    --accent-soft: #9ec2ff;
    --surface: #0b1426;
    --max: 54rem;
    --tag-model: #7aa2ff;
    --tag-industry: #5ecf9a;
    --tag-policy: #e0b35e;
    --tag-tools: #9b8cff;
    --tag-research: #4fc3f7;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background:
      radial-gradient(1200px 520px at 50% -120px, rgba(55, 110, 220, 0.18), transparent 60%),
      linear-gradient(180deg, var(--bg-deep) 0%, var(--bg) 28%, var(--bg) 100%);
    color: var(--ink);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    min-height: 100%;
  }
  a { color: var(--ink); text-decoration: none; }
  a:hover { color: var(--accent-soft); }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }
  .plain { color: inherit; }

  .wrap {
    width: min(100% - 2.5rem, var(--max));
    margin-inline: auto;
  }

  /* —— Header —— */
  .hero {
    padding: 4.75rem 0 2.5rem;
    border-bottom: 1px solid var(--line-soft);
  }
  .hero-top {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem 1.5rem;
  }
  .wordmark {
    margin: 0;
    font-size: clamp(1.85rem, 3.8vw, 2.45rem);
    font-weight: 650;
    letter-spacing: -0.035em;
    line-height: 1.08;
  }
  .wordmark span {
    color: var(--accent);
    font-weight: 500;
  }
  .lede {
    margin: 1.1rem 0 0;
    max-width: 36rem;
    color: var(--muted);
    font-size: 1.05rem;
    line-height: 1.6;
  }
  .status {
    margin: 1.35rem 0 0;
    color: var(--muted);
    font-size: 0.875rem;
    letter-spacing: 0.01em;
  }
  .status strong {
    color: var(--accent-soft);
    font-weight: 600;
  }

  /* —— Sections —— */
  main { padding: 2rem 0 5rem; }
  .block { margin-top: 3.5rem; }
  .block:first-child { margin-top: 0; }
  .block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  .block-title {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent-soft);
    opacity: 0.85;
  }

  /* —— Tabs —— */
  .rail {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0;
    margin: 0 0 0.5rem;
    border-bottom: 1px solid var(--line);
  }
  .tab {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.95rem;
    padding: 0.7rem 0.9rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    min-height: 44px;
  }
  .tab:hover { color: var(--ink); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tab.is-active {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .tab .count {
    margin-left: 0.4rem;
    color: var(--muted);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .tab.is-active .count { color: var(--accent); }

  /* —— Feed list —— */
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .item {
    padding: 1.35rem 0;
    border-bottom: 1px solid var(--line-soft);
  }
  .item:first-child { padding-top: 1rem; }
  .item-kicker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.45rem;
    font-size: 0.8rem;
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  .cat {
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-size: 0.72rem;
  }
  .cat-model-releases { color: var(--tag-model); }
  .cat-research { color: var(--tag-research); }
  .cat-industry { color: var(--tag-industry); }
  .cat-policy { color: var(--tag-policy); }
  .cat-tools-oss { color: var(--tag-tools); }
  .dot { color: var(--line); }
  .rule-tag { margin-left: auto; }
  .rule-tag a {
    color: var(--muted);
    font-size: 0.75rem;
    border-bottom: 1px solid transparent;
  }
  .rule-tag a:hover {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .item-title {
    margin: 0.45rem 0 0.35rem;
    font-size: clamp(1.1rem, 2.2vw, 1.28rem);
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.35;
  }
  .item-title a { color: var(--ink); }
  .item-title a:hover { color: var(--accent); }
  .item.is-research .item-title {
    font-size: 1.02rem;
    font-weight: 550;
  }
  .item-summary {
    margin: 0;
    color: var(--muted);
    max-width: 42rem;
  }
  .empty {
    color: var(--muted);
    padding: 1.5rem 0;
  }

  /* —— Vote —— */
  .vote-list li {
    padding: 1rem 0;
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
    padding: 1.15rem 0;
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
    font-weight: 650;
    letter-spacing: 0.04em;
  }
  .rule-body {
    margin: 0.45rem 0 0;
    color: var(--ink);
    max-width: 42rem;
  }
  .rule-cta {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }
  .rule-cta a { color: var(--muted); }
  .rule-cta a:hover { color: var(--accent); }

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
    margin: 0.25rem 0 1.25rem;
    padding: 1rem 0 0.25rem;
    border-top: 1px solid var(--line-soft);
    border-bottom: 1px solid var(--line-soft);
    display: grid;
    gap: 0.85rem 1.25rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    max-width: 42rem;
  }
  .canon-step .n {
    display: block;
    color: var(--accent);
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 650;
    margin-bottom: 0.2rem;
  }
  .canon-step .t {
    color: var(--ink);
    font-weight: 600;
    font-size: 0.95rem;
  }
  .canon-step .d {
    color: var(--muted);
    font-size: 0.875rem;
    margin-top: 0.15rem;
  }
  .how {
    margin: 0 0 1rem;
    max-width: 40rem;
    color: var(--muted);
  }
  .how strong { color: var(--ink); font-weight: 600; }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    font-size: 0.95rem;
  }
  .links a { color: var(--muted); }
  .links a:hover { color: var(--accent); }
  footer {
    padding: 0 0 3.5rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  footer code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85em;
  }
  footer .tag { color: var(--accent); }
  :target { scroll-margin-top: 1.5rem; }
  .hero-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1.1rem;
    margin: 1.5rem 0 0;
    font-size: 0.9rem;
  }
  .hero-nav a { color: var(--muted); }
  .hero-nav a:hover { color: var(--accent); }

  @media (max-width: 540px) {
    .wrap { width: min(100% - 1.5rem, var(--max)); }
    .hero { padding-top: 2.75rem; }
    .rule-tag { margin-left: 0; width: 100%; }
    .tab { padding-inline: 0.7rem; font-size: 0.9rem; }
    .canon { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
  }
</style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <div class="hero-top">
        <h1 class="wordmark">AICanon<span>Feed</span></h1>
      </div>
      <p class="lede">Community writes the rules. AI applies them. GitHub executes — a calm, chronological CANON feed for AI industry and research. No ranking. No pins.</p>
      <p class="status">
        <strong>${esc(stageInfo.stage)}</strong>
        · ${esc(stars)} stars
        · quorum ${esc(stageInfo.quorum)}
        · last ${CONTENT_MAX_AGE_DAYS} days
      </p>
      <nav class="hero-nav" aria-label="Sections">
        <a href="#latest">Latest</a>
        <a href="#vote">Vote</a>
        <a href="#rules">Rules</a>
        <a href="#about">CANON &amp; how to join</a>
      </nav>
    </div>
  </header>

  <main class="wrap">
    <section class="block" id="latest" aria-label="Latest included">
      <div class="block-head">
        <h2 class="block-title">Latest included</h2>
      </div>
      <div class="rail" role="tablist" aria-label="Filter by category">
        ${tabsHtml}
      </div>
      <div id="feed">
${feedHtml}
      </div>
      <p class="empty" id="empty-filter" hidden>Nothing in this category for the current window.</p>
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
      <p class="how"><strong>CANON</strong> in three steps: the community legislates, AI judges only by enacted rules, and GitHub (code + history) is the neutral executor.</p>
      <div class="canon" role="list">
        <div class="canon-step" role="listitem">
          <span class="n">01</span>
          <div class="t">Legislate</div>
          <div class="d">Anyone can open a rule proposal on GitHub Issues. Meta-rules M1–M6 bound what may be proposed.</div>
        </div>
        <div class="canon-step" role="listitem">
          <span class="n">02</span>
          <div class="t">Adjudicate</div>
          <div class="d">AI pre-reviews proposals and applies only ratified rules to RSS items — it never invents inclusion criteria.</div>
        </div>
        <div class="canon-step" role="listitem">
          <span class="n">03</span>
          <div class="t">Execute</div>
          <div class="d">Votes, PRs, and <code>decisions/</code> are public. No ranking, no pins, no hidden human moderation of the feed.</div>
        </div>
      </div>
      <p class="how"><strong>How to join</strong> — Propose a rule (template), vote 👍 / 👎 on issues labeled <code>voting</code>, or audit every call in <code>decisions/</code>. Rules take ~8–14 days.</p>
      <ul>
        <li>Strict reverse-chronological order. Tabs are filters, not rankings.</li>
        <li>Industry and research are both first-class; research volume is limited at ingest.</li>
        <li>Uncovered items are rejected by design.</li>
      </ul>
      <p class="links">
        <a href="https://github.com/${esc(repoSlugEnv)}">Repository</a>
        <a href="https://github.com/${esc(repoSlugEnv)}/blob/main/CONTRIBUTING.md">Contributing</a>
        <a href="https://github.com/${esc(repoSlugEnv)}/blob/main/lib/meta-rules.md">Meta-rules</a>
        <a href="https://github.com/${esc(repoSlugEnv)}/issues/new/choose">Propose a rule</a>
      </p>
    </section>
  </main>

  <footer class="wrap">
    <span class="tag">CANON</span>
    · community legislates · AI adjudicates · GitHub executes ·
    auditable in <code>decisions/</code>.
  </footer>

<script>
(function () {
  var tabs = document.querySelectorAll('.tab');
  var items = document.querySelectorAll('#feed .item');
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
