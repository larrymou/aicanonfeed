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
import { urlHash, loadSeenHashes, appendIndex } from "../lib/hash.mjs";
import { rulesFingerprint } from "../lib/fingerprint.mjs";
import { fetchFeedText, sanitizeRssXml } from "../lib/feed-xml.mjs";

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

async function moderateOne(item, items, promptBody, groups) {
  const content = [
    `source: ${item.sourceName}`,
    `title: ${stripHtml(item.title)}`,
    `link: ${item.link}`,
    `pubDate: ${item.pubDate || "unknown"}`,
    `summary: ${item.summary}`,
  ].join("\n");

  const filled = fillTemplate(promptBody, {
    RULES: rulesForPrompt(groups, items),
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
    const rule = items.find((r) => r.id === matchedRuleId);
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
    customFields: {
      item: [
        ["media:content", "mediaContent", { keepArray: true }],
        ["content:encoded", "contentEncoded"],
      ],
    },
  });

  const feeds = JSON.parse(fs.readFileSync(path.join(ROOT, "feeds.json"), "utf8"));
  const { groups, items, skipped } = loadActiveRules(path.join(ROOT, "rules"));
  log(`rules=${items.length}`, skipped.length ? `skipped=${JSON.stringify(skipped)}` : "");
  if (!items.length) {
    throw new Error("No active rules");
  }

  const promptBody = loadPrompt(
    fs.readFileSync(path.join(ROOT, "lib", "prompts", "content-moderation.md"), "utf8"),
  );
  const seen = loadSeenHashes(indexFile, contentDir);
  log(`seen size=${seen.size}`);
  log(`seen size=${seen.size}`);

  const candidates = [];
  const maxAgeMs = CONTENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let skippedStale = 0;
  let skippedNoDate = 0;
  for (const feed of feeds.rss || []) {
    try {
      const xml = sanitizeRssXml(await fetchFeedText(feed.url, { timeoutMs: 25000 }));
      const parsed = await parser.parseString(xml);
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

  // Cap research at RESEARCH_RUN_SHARE_MAX of the run; fill the rest with non-research.
  // (Not "non-research first then leftovers" — that could zero out research entirely.)
  const maxResearch = Math.floor(FEED_MAX_NEW_PER_RUN * RESEARCH_RUN_SHARE_MAX);
  const nonResearch = capped.filter((c) => !isResearchCategory(c.sourceCategory));
  const research = capped.filter((c) => isResearchCategory(c.sourceCategory));
  const researchPick = research.slice(0, Math.max(0, maxResearch));
  const nonResearchPick = nonResearch.slice(0, FEED_MAX_NEW_PER_RUN - researchPick.length);
  const batch = [...nonResearchPick, ...researchPick].sort(
    (a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0),
  );
  log(
    `candidates=${candidates.length} after_source_cap=${capped.length} batch=${batch.length} (nonR=${nonResearchPick.length} R=${researchPick.length} skipped_stale=${skippedStale} skipped_no_date=${skippedNoDate})`,
  );

  // Wall-clock budget so a hung provider cannot burn the full Actions job (6h)
  const deadline = Date.now() + 20 * 60 * 1000;

  fs.mkdirSync(contentDir, { recursive: true });
  const decidedAt = new Date().toISOString();
  const promptVersionMatch = fs
    .readFileSync(path.join(ROOT, "lib", "prompts", "content-moderation.md"), "utf8")
    .match(/^version:\s*(\S+)/m);
  const promptVersion = promptVersionMatch ? promptVersionMatch[1] : "unknown";
  const ruleFingerprint = rulesFingerprint(items);
  log(`ruleFingerprint=${ruleFingerprint}`);
  let included = 0;

  for (const item of batch) {
    if (Date.now() > deadline) {
      log(`deadline hit after ${batch.indexOf(item)}/${batch.length}; remaining deferred to next run`);
      break;
    }
    let result;
    try {
      result = await moderateOne(item, items, promptBody, groups);
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
      ruleFingerprint,
    };
    const name = `${item.urlHash}.json`;
    if (result.error) {
      // One file per hash; overwrite on retry; not indexed.
      const errDir = path.join(ROOT, "decisions", "errors");
      fs.mkdirSync(errDir, { recursive: true });
      fs.writeFileSync(path.join(errDir, name), JSON.stringify(record, null, 2) + "\n");
    } else {
      // Success: drop stale error file if any
      const errFile = path.join(ROOT, "decisions", "errors", name);
      if (fs.existsSync(errFile)) fs.unlinkSync(errFile);
      fs.writeFileSync(path.join(contentDir, `${item.urlHash}-${Date.now()}.json`), JSON.stringify(record, null, 2) + "\n");
      // Index immediately so a crash cannot leave decided files unindexed.
      appendIndex(indexFile, [{ urlHash: item.urlHash, url: item.link, decidedAt }]);
    }
    log(
      `${result.include ? "IN " : "OUT"} ${item.sourceName} ${item.matchedRuleId || "-"} ${item.title.slice(0, 60)}`,
    );
  }

  log(`done included=${included}/${batch.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
