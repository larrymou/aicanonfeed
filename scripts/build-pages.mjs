#!/usr/bin/env node
/**
 * Build static GitHub Pages site: Latest Included first, then Open for Vote, Rules, About.
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

async function main() {
  const { active: rules } = loadActiveRules(path.join(ROOT, "rules"));
  const included = loadIncluded();
  const repoSlugEnv =
    process.env.GITHUB_REPOSITORY || process.env.GH_REPO || "larrymou/aicanonfeed";

  const counts = { all: included.length };
  for (const id of Object.keys(CATEGORIES)) counts[id] = 0;
  for (const r of included) {
    const id = r.categoryId;
    if (id && counts[id] !== undefined) counts[id]++;
  }

  let stars = 0;
  let stageInfo = { stage: "S0", stars: 0, quorum: 1 };
  let votingHtml =
    '<p class="muted">Voting data unavailable (local build without GitHub token).</p>';

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
          ? ` · need ${need} more valid vote${need === 1 ? "" : "s"} (quorum ${stageInfo.quorum})`
          : up > down
            ? " · currently leading"
            : "";
      items.push(`<li>
        <a href="${esc(issue.html_url)}">${esc(issue.title)}</a>
        <span class="votes">👍 ${up} · 👎 ${down}${esc(needText)}</span>
        <span class="hint">Open the issue and react 👍 or 👎 to vote.</span>
      </li>`);
    }
    votingHtml = items.length
      ? `<ul class="feed">${items.join("\n")}</ul>`
      : `<p class="muted">No proposals open for vote right now. Propose a rule via GitHub Issues.</p>`;
  } catch (err) {
    log("GitHub unavailable:", String(err.message || err));
    stageInfo = stageForStars(process.env.STARS || 0);
  }

  const tabsHtml = TAB_ORDER.map((id, i) => {
    const n = counts[id] ?? 0;
    const active = i === 0 ? " is-active" : "";
    return `<button type="button" class="tab${active}" data-tab="${esc(id)}" aria-pressed="${i === 0 ? "true" : "false"}">${esc(tabLabel(id))} <span class="count">${n}</span></button>`;
  }).join("\n      ");

  const feedHtml = included.length
    ? included
        .map((r) => {
          const href = safeHref(r.url);
          const title = esc(r.title);
          const titleHtml = href
            ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${title}</a>`
            : title;
          const cat = r.categoryId || "";
          const catName = categoryName(cat);
          const rule = r.matchedRuleId || "";
          const isResearch = cat === "research";
          const summary = (r.summary || "").slice(0, isResearch ? 160 : SUMMARY_MAX_CHARS);
          return `<article class="card${isResearch ? " is-research" : ""}" data-category="${esc(cat)}">
  <header>
    <span class="rule"><span class="chip chip-${esc(cat)}">${esc(catName)}</span> <a href="#rule-${esc(rule)}">${esc(rule || "—")}</a></span>
    <time datetime="${esc(r.pubDate || r.decidedAt || "")}">${esc(fmtDate(r.pubDate || r.decidedAt))}</time>
  </header>
  <h2>${titleHtml}</h2>
  <p>${esc(summary)}</p>
  <p class="meta">${esc(r.sourceName || "")}</p>
</article>`;
        })
        .join("\n")
    : `<p class="muted" data-category="all">No items in the last ${CONTENT_MAX_AGE_DAYS} days. Pipeline runs every 4 hours against active rules only.</p>`;

  const rulesHtml = rules
    .map(
      (r) => `<li id="rule-${esc(r.id)}">
  <strong>${esc(r.id)}</strong> <em>${esc(categoryName(r.category))}</em>
  <br>${esc(r.body)}
  <div class="hint">Disagree? <a href="https://github.com/${esc(repoSlugEnv)}/issues/new/choose">Propose a rule change</a></div>
</li>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="AICanonFeed — community-written inclusion rules, AI-applied, chronological feed for general AI news and research.">
<title>AICanonFeed</title>
<style>
  :root {
    --bg:#0f1115; --card:#171a21; --ink:#e8eaed; --muted:#9aa0a6;
    --line:#2a2f3a; --accent:#7cb7ff;
    --tag-model:#8b9cff; --tag-industry:#5ecf9a; --tag-policy:#e0b35e;
    --tag-tools:#c792ea; --tag-research:#7cb7ff;
  }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; background:var(--bg); color:var(--ink); }
  header.site { padding:28px 20px 8px; max-width:720px; margin:0 auto; }
  header.site h1 { margin:0 0 4px; font-size:1.5rem; letter-spacing:-0.02em; }
  header.site .tagline { color:var(--ink); margin:6px 0 0; }
  header.site .status { color:var(--muted); margin:8px 0 0; font-size:0.9rem; }
  main { max-width:720px; margin:0 auto; padding:12px 20px 48px; }
  section { margin-top:28px; }
  h2.section { font-size:0.85rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin:0 0 12px; font-weight:600; }
  .rail { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0 14px; }
  .tab {
    appearance:none; border:1px solid var(--line); background:transparent; color:var(--muted);
    border-radius:999px; padding:8px 12px; font:inherit; font-size:0.9rem; cursor:pointer;
    min-height:36px;
  }
  .tab:hover { color:var(--ink); border-color:#3a4150; }
  .tab:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .tab.is-active { color:var(--bg); background:var(--ink); border-color:var(--ink); }
  .tab .count { opacity:0.75; font-variant-numeric:tabular-nums; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:10px; }
  .card.is-hidden { display:none; }
  .card.is-research { opacity:0.96; }
  .card.is-research h2 { font-size:1rem; }
  .card header { display:flex; justify-content:space-between; gap:8px; color:var(--muted); font-size:0.8rem; flex-wrap:wrap; align-items:center; }
  .card h2 { margin:8px 0 6px; font-size:1.1rem; line-height:1.35; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .card p { margin:0 0 6px; }
  .meta, .muted, .votes, .hint { color:var(--muted); font-size:0.85rem; }
  .hint { display:block; margin-top:2px; }
  .rule { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .chip {
    display:inline-block; padding:2px 8px; border-radius:999px; font-size:0.75rem;
    font-weight:600; letter-spacing:0.02em; border:1px solid var(--line); color:var(--ink);
  }
  .chip-model-releases { border-color:var(--tag-model); color:var(--tag-model); }
  .chip-research { border-color:var(--tag-research); color:var(--tag-research); }
  .chip-industry { border-color:var(--tag-industry); color:var(--tag-industry); }
  .chip-policy { border-color:var(--tag-policy); color:var(--tag-policy); }
  .chip-tools-oss { border-color:var(--tag-tools); color:var(--tag-tools); }
  ul.feed { list-style:none; padding:0; margin:0; }
  ul.feed li { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  ul.rules { padding-left:1.1rem; }
  ul.rules li { margin-bottom:14px; }
  .about ul { padding-left:1.1rem; margin:8px 0; }
  footer { max-width:720px; margin:0 auto; padding:0 20px 40px; color:var(--muted); font-size:0.85rem; }
  :target { outline:1px solid var(--accent); }
  @media (max-width:480px) {
    .card h2 { font-size:1.05rem; }
    .rail { gap:6px; }
  }
</style>
</head>
<body>
<header class="site">
  <h1>AICanonFeed</h1>
  <p class="tagline">Community rules. AI-applied. Chronological AI news — industry and research, tagged.</p>
  <p class="status">Stars: ${esc(stars)} · Stage: ${esc(stageInfo.stage)} · Quorum: ${esc(stageInfo.quorum)} · Last ${CONTENT_MAX_AGE_DAYS} days</p>
</header>
<main>
  <section id="latest" aria-label="Latest included">
    <h2 class="section">Latest Included</h2>
    <div class="rail" role="tablist" aria-label="Filter by category">
      ${tabsHtml}
    </div>
    <div id="feed">
${feedHtml}
    </div>
    <p class="muted" id="empty-filter" hidden>No items in this category for the current window.</p>
  </section>
  <section id="vote">
    <h2 class="section">Open for Vote</h2>
    ${votingHtml}
  </section>
  <section id="rules">
    <h2 class="section">Active Rules</h2>
    <ul class="rules">
${rulesHtml}
    </ul>
  </section>
  <section class="about" id="about">
    <h2 class="section">About</h2>
    <ul>
      <li>No algorithmic ranking — filter tabs only reorder by your choice; each view stays time-descending.</li>
      <li>Industry and research are both first-class; research is volume-limited at ingest so it does not drown the mix.</li>
      <li>AI only applies ratified rules; uncovered content is rejected.</li>
      <li>Rule proposals take roughly 8–14 days.</li>
    </ul>
    <p><a href="https://github.com/${esc(repoSlugEnv)}">Repository</a> · <a href="https://github.com/${esc(repoSlugEnv)}/blob/main/CONTRIBUTING.md">CONTRIBUTING</a> · <a href="https://github.com/${esc(repoSlugEnv)}/issues/new/choose">Propose a rule</a></p>
  </section>
</main>
<footer>All decisions are auditable in <code>decisions/</code>.</footer>
<script>
(function () {
  var tabs = document.querySelectorAll('.tab');
  var cards = document.querySelectorAll('#feed .card');
  var empty = document.getElementById('empty-filter');
  var emptyAll = document.querySelector('#feed p.muted');

  function apply(id) {
    var visible = 0;
    cards.forEach(function (el) {
      var cat = el.getAttribute('data-category') || '';
      var show = id === 'all' || cat === id;
      el.classList.toggle('is-hidden', !show);
      if (show) visible++;
    });
    if (emptyAll) emptyAll.hidden = id !== 'all' || visible > 0;
    if (empty) empty.hidden = !(id !== 'all' && visible === 0);
  }

  tabs.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabs.forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      apply(btn.getAttribute('data-tab'));
      if (history.replaceState) history.replaceState(null, '', '#' + btn.getAttribute('data-tab'));
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
