#!/usr/bin/env node
/**
 * Build static GitHub Pages site: Latest Included first, then Open for Vote, Rules, About.
 */
import fs from "node:fs";
import path from "node:path";
import { SUMMARY_MAX_CHARS, stageForStars, LABELS } from "../lib/constants.mjs";
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

function loadIncluded() {
  const dir = path.join(ROOT, "decisions", "content-reviews");
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (obj.include === true) rows.push(obj);
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

async function main() {
  const { active: rules } = loadActiveRules(path.join(ROOT, "rules"));
  const included = loadIncluded();

  let stars = 0;
  let stageInfo = { stage: "S0", stars: 0, quorum: 1 };
  let votingHtml = "<p class=\"muted\">Voting data unavailable (local build without GitHub token).</p>";

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
        for (const r of reactions) {
          if (r.content === "+1" || r.content === "heart" || r.content === "hooray") up++;
          if (r.content === "-1" || r.content === "confused") down++;
        }
      } catch {
        /* ignore */
      }
      items.push(`<li>
        <a href="${esc(issue.html_url)}">${esc(issue.title)}</a>
        <span class="votes">👍 ${up} · 👎 ${down}</span>
      </li>`);
    }
    votingHtml = items.length
      ? `<ul class="feed">${items.join("\n")}</ul>`
      : `<p class="muted">No proposals open for vote right now.</p>`;
  } catch (err) {
    log("GitHub unavailable:", String(err.message || err));
    stageInfo = stageForStars(process.env.STARS || 0);
  }

  const feedHtml = included.length
    ? included
        .map(
          (r) => `<article class="card">
  <header>
    <span class="rule">${esc(r.matchedRuleId || "")}</span>
    <time datetime="${esc(r.pubDate || r.decidedAt || "")}">${esc(fmtDate(r.pubDate || r.decidedAt))}</time>
  </header>
  <h2><a href="${esc(r.url)}" rel="noopener noreferrer" target="_blank">${esc(r.title)}</a></h2>
  <p>${esc((r.summary || "").slice(0, SUMMARY_MAX_CHARS))}</p>
  <p class="meta">${esc(r.sourceName || "")}</p>
</article>`,
        )
        .join("\n")
    : `<p class="muted">No items included yet. The pipeline is running against community rules.</p>`;

  const rulesHtml = rules
    .map(
      (r) => `<li><strong>${esc(r.id)}</strong> <em>${esc(r.category)}</em><br>${esc(r.body)}</li>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AICanonFeed</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --ink:#e8eaed; --muted:#9aa0a6; --line:#2a2f3a; --accent:#7cb7ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--ink); }
  header.site { padding:28px 20px 8px; max-width:720px; margin:0 auto; }
  header.site h1 { margin:0 0 4px; font-size:1.5rem; }
  header.site p { margin:0; color:var(--muted); }
  main { max-width:720px; margin:0 auto; padding:12px 20px 48px; }
  section { margin-top:28px; }
  h2.section { font-size:0.85rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin:0 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:10px; }
  .card header { display:flex; justify-content:space-between; gap:8px; color:var(--muted); font-size:0.8rem; }
  .card h2 { margin:6px 0; font-size:1.05rem; }
  .card a { color:var(--accent); text-decoration:none; }
  .card a:hover { text-decoration:underline; }
  .card p { margin:0 0 6px; }
  .meta, .muted, .votes { color:var(--muted); font-size:0.85rem; }
  .rule { color:var(--accent); font-weight:600; }
  ul.feed { list-style:none; padding:0; margin:0; }
  ul.feed li { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  ul.rules { padding-left:1.1rem; }
  ul.rules li { margin-bottom:10px; }
  footer { max-width:720px; margin:0 auto; padding:0 20px 40px; color:var(--muted); font-size:0.85rem; }
</style>
</head>
<body>
<header class="site">
  <h1>AICanonFeed</h1>
  <p>Community writes the rules. AI applies them. Chronological inclusion feed.</p>
  <p class="muted">Stars: ${esc(stars)} · Stage: ${esc(stageInfo.stage)} · Quorum: ${esc(stageInfo.quorum)}</p>
</header>
<main>
  <section>
    <h2 class="section">Latest Included</h2>
    ${feedHtml}
  </section>
  <section>
    <h2 class="section">Open for Vote</h2>
    ${votingHtml}
  </section>
  <section>
    <h2 class="section">Active Rules</h2>
    <ul class="rules">
${rulesHtml}
    </ul>
  </section>
  <section>
    <h2 class="section">About</h2>
    <p>No algorithmic ranking. No manual pin. Strict reverse-chronological inclusion under community rules only. Uncovered content is rejected.</p>
    <p>See <a href="https://github.com/${process.env.GITHUB_REPOSITORY || "your-org/aicanonfeed"}">the repository</a> and CONTRIBUTING to propose rules.</p>
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
