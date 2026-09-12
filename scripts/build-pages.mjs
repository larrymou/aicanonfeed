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

/** Only allow http(s) links in the public page. */
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

/** Match settlement semantics: 👍/👎 only. */
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

async function main() {
  const { active: rules } = loadActiveRules(path.join(ROOT, "rules"));
  const included = loadIncluded();
  const repoSlugEnv =
    process.env.GITHUB_REPOSITORY || process.env.GH_REPO || "larrymou/aicanonfeed";

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

  const feedHtml = included.length
    ? included
        .map((r) => {
          const href = safeHref(r.url);
          const title = esc(r.title);
          const titleHtml = href
            ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${title}</a>`
            : title;
          const cat = categoryName(r.categoryId);
          const rule = r.matchedRuleId || "";
          return `<article class="card">
  <header>
    <span class="rule"><a href="#rule-${esc(rule)}">${esc(rule || "—")}</a> · ${esc(cat)}</span>
    <time datetime="${esc(r.pubDate || r.decidedAt || "")}">${esc(fmtDate(r.pubDate || r.decidedAt))}</time>
  </header>
  <h2>${titleHtml}</h2>
  <p>${esc((r.summary || "").slice(0, SUMMARY_MAX_CHARS))}</p>
  <p class="meta">${esc(r.sourceName || "")}</p>
</article>`;
        })
        .join("\n")
    : `<p class="muted">No items in the last ${CONTENT_MAX_AGE_DAYS} days. Pipeline runs every 4 hours against active rules only.</p>`;

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
<meta name="description" content="AICanonFeed — community-written inclusion rules, AI-applied, chronological feed.">
<title>AICanonFeed</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --ink:#e8eaed; --muted:#9aa0a6; --line:#2a2f3a; --accent:#7cb7ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--ink); }
  header.site { padding:28px 20px 8px; max-width:720px; margin:0 auto; }
  header.site h1 { margin:0 0 4px; font-size:1.5rem; }
  header.site p { margin:0; color:var(--muted); }
  header.site .tagline { color:var(--ink); margin-top:6px; }
  main { max-width:720px; margin:0 auto; padding:12px 20px 48px; }
  section { margin-top:28px; }
  h2.section { font-size:0.85rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin:0 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:10px; }
  .card header { display:flex; justify-content:space-between; gap:8px; color:var(--muted); font-size:0.8rem; flex-wrap:wrap; }
  .card h2 { margin:6px 0; font-size:1.1rem; line-height:1.35; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .card p { margin:0 0 6px; }
  .meta, .muted, .votes, .hint { color:var(--muted); font-size:0.85rem; }
  .hint { display:block; margin-top:2px; }
  .rule { color:var(--accent); font-weight:600; }
  .rule a { color:inherit; }
  ul.feed { list-style:none; padding:0; margin:0; }
  ul.feed li { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  ul.rules { padding-left:1.1rem; }
  ul.rules li { margin-bottom:14px; }
  .about ul { padding-left:1.1rem; margin:8px 0; }
  footer { max-width:720px; margin:0 auto; padding:0 20px 40px; color:var(--muted); font-size:0.85rem; }
  :target { outline:1px solid var(--accent); }
</style>
</head>
<body>
<header class="site">
  <h1>AICanonFeed</h1>
  <p class="tagline">Community writes the rules. AI applies them. Chronological inclusion feed — no ranking, no pins.</p>
  <p class="muted">Stars: ${esc(stars)} · Stage: ${esc(stageInfo.stage)} · Quorum: ${esc(stageInfo.quorum)} · Window: last ${CONTENT_MAX_AGE_DAYS} days</p>
</header>
<main>
  <section id="latest">
    <h2 class="section">Latest Included</h2>
    ${feedHtml}
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
      <li>No algorithmic ranking and no manual pin — strict reverse-chronological.</li>
      <li>AI only applies ratified rules; uncovered content is rejected.</li>
      <li>Platform does not hand-review feed items; decisions live in <code>decisions/</code>.</li>
      <li>Rule proposals take roughly 8–14 days (pre-review → vote → merge).</li>
    </ul>
    <p><a href="https://github.com/${esc(repoSlugEnv)}">Repository</a> · <a href="https://github.com/${esc(repoSlugEnv)}/blob/main/CONTRIBUTING.md">CONTRIBUTING</a> · <a href="https://github.com/${esc(repoSlugEnv)}/issues/new/choose">Propose a rule</a></p>
  </section>
</main>
<footer>All decisions are auditable in <code>decisions/</code>.</footer>
</body>
</html>
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "index.html");
  fs.writeFileSync(outFile, html, "utf8");
  log(`wrote ${outFile} (${included.length} included items)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
