#!/usr/bin/env node
/**
 * Content pipeline: fetch RSS → dedupe → AI moderate → write decisions.
 */
import fs from "node:fs";
import path from "node:path";
import Parser from "rss-parser";
import { FEED_MAX_NEW_PER_RUN, SUMMARY_MAX_CHARS, CONTENT_MAX_AGE_DAYS, DEFAULT_SOURCE_MAX_PER_RUN, RESEARCH_RUN_SHARE_MAX, isResearchCategory, isCategory } from "../lib/constants.mjs";
import { chatJSON, loadPrompt, fillTemplate } from "../lib/llm.mjs";
import { loadActiveRules, rulesForPrompt } from "../lib/rules.mjs";
import { urlHash, loadIndexFile, appendIndex } from "../lib/hash.mjs";

const ROOT = process.cwd();
const contentDir = path.join(ROOT, "decisions", "content-reviews");
const indexFile = path.join(ROOT, "decisions", "index.jsonl");

function log(...args) {
  console.log("[pipeline]", ...args);
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(item) {
  const desc = stripHtml(item.contentSnippet || item.content || item.summary || item.description || "");
  if (desc) return desc.slice(0, SUMMARY_MAX_CHARS);
  return stripHtml(item.title || "").slice(0, SUMMARY_MAX_CHARS);
}

async function moderateOne(item, rules, promptBody) {
  const content = [
    `source: ${item.sourceName}`,
    `title: ${stripHtml(item.title)}`,
    `link: ${item.link}`,
    `pubDate: ${item.pubDate || "unknown"}`,
    `summary: ${item.summary}`,
  ].join("\n");

  const filled = fillTemplate(promptBody, {
    RULES: rulesForPrompt(rules),
    CONTENT: content,
  });

  const res = await chatJSON({
    system: filled,
    user: "Apply the rules above. Return JSON only.",
  });

  const include = res.include === true;
  let matchedRuleId = res.matchedRuleId || null;
  let categoryId = res.categoryId || null;
  if (include) {
    const rule = rules.find((r) => r.id === matchedRuleId);
    if (!rule) {
      return {
        include: false,
        matchedRuleId: null,
        categoryId: null,
        reason: "Forced reject: invalid matchedRuleId",
      };
    }
    categoryId = rule.category;
    if (!isCategory(categoryId)) {
      return {
        include: false,
        matchedRuleId: null,
        categoryId: null,
        reason: "Forced reject: invalid category",
      };
    }
  } else {
    matchedRuleId = null;
    categoryId = null;
  }
  return {
    include,
    matchedRuleId,
    categoryId,
    reason: String(res.reason || "").slice(0, 300),
  };
}

async function main() {
  const parser = new Parser({
    timeout: 20000,
    customFields: {
      item: [
        ["media:content", "mediaContent", { keepArray: true }],
        ["content:encoded", "contentEncoded"],
      ],
    },
  });

  const feeds = JSON.parse(fs.readFileSync(path.join(ROOT, "feeds.json"), "utf8"));
  const { active: rules, skipped } = loadActiveRules(path.join(ROOT, "rules"));
  log(`rules=${rules.length}`, skipped.length ? `skipped=${JSON.stringify(skipped)}` : "");
  if (!rules.length) {
    throw new Error("No active rules");
  }

  const promptBody = loadPrompt(
    fs.readFileSync(path.join(ROOT, "lib", "prompts", "content-moderation.md"), "utf8"),
  );
  const seen = loadIndexFile(indexFile);
  log(`index size=${seen.size}`);

  const candidates = [];
  const maxAgeMs = CONTENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let skippedStale = 0;
  let skippedNoDate = 0;
  for (const feed of feeds.rss || []) {
    try {
      // rss-parser timeout is unreliable for some hosts; enforce our own
      const parsed = await Promise.race([
        parser.parseURL(feed.url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`feed timeout: ${feed.name}`)), 25000),
        ),
      ]);
      const items = parsed.items || [];
      log(`${feed.name}: ${items.length} items`);
      for (const it of items) {
        const link = it.link || it.guid || it.id;
        if (!link) continue;
        const h = urlHash(link);
        if (seen.has(h)) continue;
        const pubRaw = it.isoDate || it.pubDate || null;
        if (!pubRaw) {
          skippedNoDate++;
          continue;
        }
        const pubMs = new Date(pubRaw).getTime();
        if (!Number.isFinite(pubMs) || now - pubMs > maxAgeMs) {
          skippedStale++;
          continue;
        }
        candidates.push({
          sourceName: feed.name,
          sourceCategory: feed.category || null,
          maxPerRun: Number(feed.maxPerRun) > 0 ? Number(feed.maxPerRun) : DEFAULT_SOURCE_MAX_PER_RUN,
          link,
          title: it.title || "",
          pubDate: pubRaw,
          summary: summarize(it),
          urlHash: h,
        });
      }
    } catch (err) {
      console.error(`[pipeline] feed fail ${feed.name}:`, String(err.message || err));
    }
  }

  // Newest first within each source, then apply per-source caps
  candidates.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  const bySource = new Map();
  const capped = [];
  for (const c of candidates) {
    const n = bySource.get(c.sourceName) || 0;
    if (n >= (c.maxPerRun || DEFAULT_SOURCE_MAX_PER_RUN)) continue;
    bySource.set(c.sourceName, n + 1);
    capped.push(c);
  }

  // Non-research first so mixed feed stays balanced; research fills remaining budget
  const researchBudget = Math.floor(FEED_MAX_NEW_PER_RUN * RESEARCH_RUN_SHARE_MAX);
  const nonResearch = capped.filter((c) => !isResearchCategory(c.sourceCategory));
  const research = capped.filter((c) => isResearchCategory(c.sourceCategory));
  const batch = [
    ...nonResearch.slice(0, FEED_MAX_NEW_PER_RUN),
    ...research.slice(0, Math.max(0, researchBudget)),
  ]
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .slice(0, FEED_MAX_NEW_PER_RUN);
  log(
    `candidates=${candidates.length} after_source_cap=${capped.length} batch=${batch.length} (nonR=${nonResearch.length} R=${research.length} skipped_stale=${skippedStale} skipped_no_date=${skippedNoDate})`,
  );

  // Wall-clock budget so a hung provider cannot burn the full Actions job (6h)
  const deadline = Date.now() + 20 * 60 * 1000;

  fs.mkdirSync(contentDir, { recursive: true });
  const decidedAt = new Date().toISOString();
  const promptVersionMatch = fs
    .readFileSync(path.join(ROOT, "lib", "prompts", "content-moderation.md"), "utf8")
    .match(/^version:\s*(\S+)/m);
  const promptVersion = promptVersionMatch ? promptVersionMatch[1] : "unknown";
  let included = 0;
  const indexRows = [];

  for (const item of batch) {
    if (Date.now() > deadline) {
      log(`deadline hit after ${batch.indexOf(item)}/${batch.length}; remaining deferred to next run`);
      break;
    }
    let result;
    try {
      result = await moderateOne(item, rules, promptBody);
    } catch (err) {
      result = {
        include: false,
        matchedRuleId: null,
        categoryId: null,
        reason: `error: ${String(err.message).slice(0, 200)}`,
        error: true,
      };
    }
    if (result.include) included++;

    const record = {
      urlHash: item.urlHash,
      url: item.link,
      sourceName: item.sourceName,
      title: item.title,
      summary: item.summary,
      pubDate: item.pubDate,
      decidedAt,
      include: result.include,
      categoryId: result.categoryId,
      matchedRuleId: result.matchedRuleId,
      reason: result.reason,
      promptVersion,
    };
    const name = `${item.urlHash}-${Date.now()}.json`;
    if (result.error) {
      // Keep noise out of content-reviews; do not index so the URL can retry.
      const errDir = path.join(ROOT, "decisions", "errors");
      fs.mkdirSync(errDir, { recursive: true });
      fs.writeFileSync(path.join(errDir, name), JSON.stringify(record, null, 2) + "\n");
    } else {
      fs.writeFileSync(path.join(contentDir, name), JSON.stringify(record, null, 2) + "\n");
      indexRows.push({ urlHash: item.urlHash, url: item.link, decidedAt });
    }
    log(
      `${result.include ? "IN " : "OUT"} ${item.sourceName} ${item.matchedRuleId || "-"} ${item.title.slice(0, 60)}`,
    );
  }

  appendIndex(indexFile, indexRows);
  log(`done included=${included}/${batch.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
