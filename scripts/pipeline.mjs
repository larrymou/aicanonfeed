#!/usr/bin/env node
/**
 * Content pipeline: fetch RSS → dedupe → AI moderate → write decisions + run summary.
 */
import fs from "node:fs";
import path from "node:path";
import Parser from "rss-parser";
import { FEED_MAX_NEW_PER_RUN, SUMMARY_MAX_CHARS, CONTENT_MAX_AGE_DAYS, DEFAULT_SOURCE_MAX_PER_RUN, RESEARCH_RUN_SHARE_MAX, isResearchCategory, isCategory } from "../lib/constants.mjs";
import { chatJSON, loadPrompt, fillTemplate, llmEnv, sanitizeUntrusted } from "../lib/llm.mjs";
import { loadActiveRules, rulesForPrompt } from "../lib/rules.mjs";
import { urlHash, loadSeenHashes, appendIndex, claimUrlHash } from "../lib/hash.mjs";
import { rulesFingerprint, promptBodyHash, EVIDENCE_ENGINE_VERSION } from "../lib/fingerprint.mjs";
import { buildObservedEvidence, enforceEvidence, FUTURE_SKEW_MS } from "../lib/evidence.mjs";
import { fetchFeedText, sanitizeRssXml } from "../lib/feed-xml.mjs";
import { normalizeContentVerdict } from "../lib/voting.mjs";
import { researchAdmission, researchCandidateCap, countsAsResearch } from "../lib/pipeline-policy.mjs";
import { commitPaths } from "../lib/git-commit.mjs";

const ROOT = process.cwd();
const contentDir = path.join(ROOT, "decisions", "content-reviews");
const indexFile = path.join(ROOT, "decisions", "index.jsonl");
const runsDir = path.join(ROOT, "decisions", "content-runs");

// Mutable run audit state — written by main(), read by the abort handler so a
// crashed run can still report its id and how far it got.
const runAudit = {
  runId: null,
  decidedCount: 0,
  includedCount: 0,
  quotaDeferredCount: 0,
  errorCount: 0,
  modelReviewedCount: 0,
  batchSize: 0,
  notReviewedCount: 0,
  pendingResearchCount: 0,
  pendingResearchJournal: null,
};

function log(...args) {
  console.log("[pipeline]", ...args);
}

function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** Never overwrite a decision file — same-ms writes get a numeric suffix. */
function uniqueJsonPath(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, name);
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length || undefined);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, `${base}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    // Decode specific entities BEFORE &amp; so `&amp;lt;` stays `&lt;`
    // (one decode) instead of collapsing to `<`.
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(item) {
  const desc = stripHtml(item.contentSnippet || item.content || item.summary || item.description || "");
  if (desc) return { text: desc.slice(0, SUMMARY_MAX_CHARS), source: "summary" };
  // Title fallback is NOT a real summary — do not treat as summary evidence.
  return { text: stripHtml(item.title || "").slice(0, SUMMARY_MAX_CHARS), source: "title_fallback" };
}

function emptySourceStats(name) {
  return {
    sourceName: name,
    discovered: 0,
    skipped_seen: 0,
    skipped_same_run_dup: 0,
    skipped_no_link: 0,
    skipped_no_date: 0,
    skipped_stale: 0,
    skipped_deadline: 0,
    fetch_error: 0,
    fetch_error_message: null,
    candidates: 0,
    source_cap_dropped: 0,
    research_cap_dropped: 0,
    run_quota_dropped: 0,
  };
}

async function moderateOne(item, items, promptBody, groups, observed) {
  const content = [
    `sourceName: ${sanitizeUntrusted(item.sourceName)}`,
    `title: ${sanitizeUntrusted(stripHtml(item.title))}`,
    `link: ${sanitizeUntrusted(item.link)}`,
    `linkHost: ${sanitizeUntrusted(observed.linkHost || "unknown")}`,
    `pubDate: ${item.pubDate || "unknown"}`,
    `summary: ${sanitizeUntrusted(item.summary)}`,
    `summarySource: ${observed.summarySource || "unknown"}`,
    `observedNote: only these fields are available; linked page content/author/owner-domain are not observed`,
  ].join("\n");

  const filled = fillTemplate(promptBody, {
    RULES: rulesForPrompt(groups, items),
    CONTENT: content,
  });

  const res = await chatJSON({
    system: filled,
    user: "Apply the rules above. Return JSON only.",
  });

  // Invalid model JSON (missing/`{}`/non-boolean include) is a tooling error —
  // never a permanent content decision that would pin the URL as seen.
  // `include: true` with a missing/unknown matchedRuleId is likewise protocol
  // failure (retry), not a grounded content reject.
  const knownIds = new Set(items.map((r) => r.id));
  const shape = normalizeContentVerdict(res, { knownRuleIds: knownIds });
  if (!shape.ok) {
    return {
      include: false,
      matchedRuleId: null,
      categoryId: null,
      reason: `error: invalid model JSON (${shape.error})`,
      error: true,
      evidenceStatus: "insufficient",
    };
  }

  const include = shape.include === true;
  let matchedRuleId = res.matchedRuleId || null;
  let categoryId = res.categoryId || null;
  let matchedRule = null;
  let result;
  if (include) {
    const rule = items.find((r) => r.id === matchedRuleId);
    if (!rule) {
      result = {
        include: false,
        matchedRuleId: null,
        categoryId: null,
        reason: "Forced reject: invalid matchedRuleId",
      };
    } else {
      matchedRule = rule;
      categoryId = rule.category;
      if (!isCategory(categoryId)) {
        result = {
          include: false,
          matchedRuleId: null,
          categoryId: null,
          reason: "Forced reject: invalid category",
        };
        matchedRule = null;
      } else {
        result = {
          include: true,
          matchedRuleId,
          categoryId,
          reason: String(res.reason || "").slice(0, 300),
          evidenceStatus: res.evidenceStatus || null,
          evidenceCitations: res.evidenceCitations || [],
        };
      }
    }
  } else {
    result = {
      include: false,
      matchedRuleId: null,
      categoryId: null,
      reason: String(res.reason || "").slice(0, 300),
      evidenceStatus: res.evidenceStatus || null,
      evidenceCitations: res.evidenceCitations || [],
    };
  }
  return enforceEvidence(result, observed, matchedRule);
}

async function main() {
  // Stable id for this pipeline run — shared by per-item decisions, the run
  // summary, and the abort record so partial work can be audited.
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  runAudit.runId = runId;
  const pendingResearchJournal = path.join(
    ROOT,
    "decisions",
    "content-runs",
    `${runId}-research-events.jsonl`,
  );
  runAudit.pendingResearchJournal = pendingResearchJournal;
  // Total budget from process start (includes RSS fetch). Workflow hard-ceiling
  // is 25 min — reserve 3 min for commit/push + abort summary so a slow model
  // call cannot burn the whole job and leave no audit trail.
  const startedAt = Date.now();
  const deadline = startedAt + 22 * 60 * 1000;
  const timeLeftMs = () => deadline - Date.now();
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(pendingResearchJournal, "", "utf8");
  let uncheckpointedAuditEvents = 0;
  const appendResearchEvent = (event) => {
    fs.appendFileSync(
      pendingResearchJournal,
      JSON.stringify({ runId, recordedAt: new Date().toISOString(), ...event }) + "\n",
      "utf8",
    );
    uncheckpointedAuditEvents++;
  };
  const persistRunAudit = (force = false) => {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      (!force && uncheckpointedAuditEvents === 0)
    ) return;
    const persisted = commitPaths(
      ["decisions"],
      `chore: checkpoint content audit ${runId}`,
    );
    if (!persisted.ok) {
      throw new Error(`Content audit checkpoint failed: ${persisted.error || "unknown error"}`);
    }
    uncheckpointedAuditEvents = 0;
  };
  const writeResearchEvent = (event) => {
    appendResearchEvent(event);
    persistRunAudit();
  };
  // Publish the run identity before fetching feeds so an interrupted run
  // without research candidates can still be distinguished from an old run.
  appendResearchEvent({ event: "run_started" });
  persistRunAudit();

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
  const rulesContext = rulesForPrompt(groups, items);
  const model = (() => {
    try {
      return llmEnv().model;
    } catch {
      return process.env.LLM_MODEL || "unknown";
    }
  })();

  const seen = loadSeenHashes(indexFile, contentDir);
  log(`seen size=${seen.size}`);
  const runOccupied = new Set();

  const sourceStats = new Map();
  const bump = (name, key) => {
    if (!sourceStats.has(name)) sourceStats.set(name, emptySourceStats(name));
    sourceStats.get(name)[key]++;
  };

  const candidates = [];
  const maxAgeMs = CONTENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const dropped = []; // not entered review: { urlHash, url, reason, sourceName }
  const quotaDeferredResearch = [];

  const feedList = feeds.rss || [];
  for (let fi = 0; fi < feedList.length; fi++) {
    const feed = feedList[fi];
    const name = feed.name;
    if (!sourceStats.has(name)) sourceStats.set(name, emptySourceStats(name));
    if (timeLeftMs() < 60_000) {
      log(`deadline near at RSS fetch — stop fetching sources`);
      // Record every remaining source so the run summary shows what was skipped.
      for (let j = fi; j < feedList.length; j++) {
        const restName = feedList[j].name;
        if (!sourceStats.has(restName)) sourceStats.set(restName, emptySourceStats(restName));
        bump(restName, "skipped_deadline");
      }
      break;
    }
    try {
      const xml = sanitizeRssXml(await fetchFeedText(feed.url, { timeoutMs: 25000 }));
      const parsed = await parser.parseString(xml);
      const rawItems = parsed.items || [];
      log(`${feed.name}: ${rawItems.length} items`);
      for (const it of rawItems) {
        const link = it.link || it.guid || it.id;
        bump(name, "discovered");
        if (!link) {
          bump(name, "skipped_no_link");
          dropped.push({ urlHash: null, url: null, reason: "no_link", sourceName: name });
          continue;
        }
        const h = urlHash(link);
        if (seen.has(h)) {
          bump(name, "skipped_seen");
          dropped.push({ urlHash: h, url: link, reason: "already_decided", sourceName: name });
          continue;
        }
        const pubRaw = it.isoDate || it.pubDate || null;
        if (!pubRaw) {
          bump(name, "skipped_no_date");
          dropped.push({ urlHash: h, url: link, reason: "no_date", sourceName: name });
          continue;
        }
        const pubMs = new Date(pubRaw).getTime();
        if (!Number.isFinite(pubMs) || now - pubMs > maxAgeMs) {
          bump(name, "skipped_stale");
          dropped.push({ urlHash: h, url: link, reason: "stale", sourceName: name });
          continue;
        }
        if (pubMs > now + FUTURE_SKEW_MS) {
          bump(name, "skipped_stale");
          dropped.push({ urlHash: h, url: link, reason: "future_date", sourceName: name });
          continue;
        }
        // Do NOT claim here — a source-capped sighting must not block another
        // source's valid copy. Claim only when the item enters the final batch.
        bump(name, "candidates");
        const summed = summarize(it);
        candidates.push({
          sourceName: feed.name,
          sourceCategory: feed.category || null,
          maxPerRun: Number(feed.maxPerRun) > 0 ? Number(feed.maxPerRun) : DEFAULT_SOURCE_MAX_PER_RUN,
          link,
          title: stripHtml(it.title || "").slice(0, 500),
          pubDate: pubRaw,
          summary: summed.text,
          summarySource: summed.source,
          urlHash: h,
        });
      }
    } catch (err) {
      console.error(`[pipeline] feed fail ${feed.name}:`, String(err.message || err));
      // Surface fetch failures in the public run summary (not console-only).
      bump(name, "fetch_error");
      sourceStats.get(name).fetch_error_message = String(err.message || err).slice(0, 200);
      dropped.push({
        urlHash: null,
        url: feed.url || null,
        reason: "fetch_error",
        sourceName: name,
      });
    }
  }

  // Newest first within each source, then apply per-source caps (unique URLs).
  candidates.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  const bySource = new Map();
  const bySourceHashes = new Map();
  const capped = [];
  const sourceOverflow = [];
  for (const c of candidates) {
    const hashes = bySourceHashes.get(c.sourceName) || new Set();
    // Same URL from the same source does not consume a source slot twice.
    if (hashes.has(c.urlHash)) {
      bump(c.sourceName, "skipped_same_run_dup");
      dropped.push({
        urlHash: c.urlHash,
        url: c.link,
        reason: "same_run_duplicate",
        sourceName: c.sourceName,
      });
      continue;
    }
    const n = bySource.get(c.sourceName) || 0;
    if (n >= (c.maxPerRun || DEFAULT_SOURCE_MAX_PER_RUN)) {
      sourceOverflow.push(c);
      continue;
    }
    bySource.set(c.sourceName, n + 1);
    hashes.add(c.urlHash);
    bySourceHashes.set(c.sourceName, hashes);
    capped.push(c);
  }

  // Cap research at RESEARCH_RUN_SHARE_MAX of the run; fill the rest with non-research.
  // Overflow backfill must NOT raise research above maxResearch.
  const nonResearch = capped.filter((c) => !isResearchCategory(c.sourceCategory));
  const research = capped.filter((c) => isResearchCategory(c.sourceCategory));
  const maxResearch = researchCandidateCap({
    nonResearchCandidates: new Set(nonResearch.map((c) => c.urlHash)).size,
    runLimit: FEED_MAX_NEW_PER_RUN,
    share: RESEARCH_RUN_SHARE_MAX,
  });
  const researchPick = research.slice(0, Math.max(0, maxResearch));
  const nonResearchPick = nonResearch.slice(
    0,
    Math.min(nonResearch.length, FEED_MAX_NEW_PER_RUN - researchPick.length),
  );
  const researchOverflow = research.slice(researchPick.length);
  const nonResearchOverflow = nonResearch.slice(nonResearchPick.length);

  // Final batch: claim hashes only now so a quota-dropped first sighting cannot
  // block another source's copy. Prefer picks, then promote from overflow
  // while still respecting the research share cap.
  const batch = [];
  const preferred = [...nonResearchPick, ...researchPick];
  const fallback = [...nonResearchOverflow, ...researchOverflow];
  const used = new Set();
  const freedSourceSlots = new Map();
  let researchInBatch = 0;
  const freeSourceSlot = (c) => {
    freedSourceSlots.set(c.sourceName, (freedSourceSlots.get(c.sourceName) || 0) + 1);
  };
  for (const c of [...preferred, ...fallback]) {
    if (batch.length >= FEED_MAX_NEW_PER_RUN) {
      if (!used.has(c)) {
        bump(c.sourceName, "run_quota_dropped");
        dropped.push({
          urlHash: c.urlHash,
          url: c.link,
          reason: "run_quota",
          sourceName: c.sourceName,
        });
        used.add(c);
      }
      continue;
    }
    const isR = isResearchCategory(c.sourceCategory);
    if (isR && researchInBatch >= maxResearch) {
      freeSourceSlot(c);
      if (!used.has(c)) {
        bump(c.sourceName, "research_cap_dropped");
        dropped.push({
          urlHash: c.urlHash,
          url: c.link,
          reason: "research_share",
          sourceName: c.sourceName,
        });
        used.add(c);
      }
      continue;
    }
    if (batch.some((b) => b.urlHash === c.urlHash)) {
      freeSourceSlot(c);
      bump(c.sourceName, "skipped_same_run_dup");
      dropped.push({
        urlHash: c.urlHash,
        url: c.link,
        reason: "same_run_duplicate",
        sourceName: c.sourceName,
      });
      used.add(c);
      continue;
    }
    const claim = claimUrlHash({ seen, runOccupied, hash: c.urlHash });
    if (claim) {
      freeSourceSlot(c);
      bump(c.sourceName, claim === "already_decided" ? "skipped_seen" : "skipped_same_run_dup");
      dropped.push({
        urlHash: c.urlHash,
        url: c.link,
        reason: claim === "already_decided" ? "already_decided" : "same_run_duplicate",
        sourceName: c.sourceName,
      });
      used.add(c);
      continue;
    }
    batch.push(c);
    if (isR) researchInBatch++;
    used.add(c);
  }
  for (const c of fallback) {
    if (!used.has(c)) {
      bump(c.sourceName, "run_quota_dropped");
      dropped.push({
        urlHash: c.urlHash,
        url: c.link,
        reason: "run_quota",
        sourceName: c.sourceName,
      });
      used.add(c);
    }
  }
  const backfilled = new Set();
  for (const c of sourceOverflow) {
    if (batch.length >= FEED_MAX_NEW_PER_RUN) break;
    const freeSlots = freedSourceSlots.get(c.sourceName) || 0;
    if (!freeSlots || batch.some((b) => b.urlHash === c.urlHash)) continue;
    const isR = isResearchCategory(c.sourceCategory);
    if (isR && researchInBatch >= maxResearch) continue;
    const claim = claimUrlHash({ seen, runOccupied, hash: c.urlHash });
    if (claim) continue;
    batch.push(c);
    if (isR) researchInBatch++;
    freedSourceSlots.set(c.sourceName, freeSlots - 1);
    backfilled.add(c);
  }
  for (const c of sourceOverflow) {
    if (backfilled.has(c)) continue;
    bump(c.sourceName, "source_cap_dropped");
    dropped.push({
      urlHash: c.urlHash,
      url: c.link,
      reason: "source_cap",
      sourceName: c.sourceName,
    });
  }
  batch.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  log(
    `candidates=${candidates.length} after_source_cap=${capped.length} batch=${batch.length} research=${researchInBatch}/${maxResearch} dropped_not_reviewed=${dropped.length}`,
  );

  // Deadline is set at process start (includes fetch). Re-check before model calls.
  log(`time budget: ${Math.max(0, Math.round(timeLeftMs() / 1000))}s left of 22min`);

  const decidedAt = new Date().toISOString();
  const promptVersionMatch = fs
    .readFileSync(path.join(ROOT, "lib", "prompts", "content-moderation.md"), "utf8")
    .match(/^version:\s*(\S+)/m);
  const promptVersion = promptVersionMatch ? promptVersionMatch[1] : "unknown";
  const ruleFingerprint = rulesFingerprint({
    groups,
    items,
    promptBody,
    model,
    rulesContext,
  });
  log(`ruleFingerprint=${ruleFingerprint} model=${model} promptVersion=${promptVersion} runId=${runId}`);
  let included = 0;
  let decided = 0;
  let evidenceForcedReject = 0;
  let errors = 0;
  runAudit.batchSize = batch.length;
  runAudit.notReviewedCount = dropped.length;
  let deferredByDeadline = 0;
  let deferredByResearchShare = 0;
  let researchSlotsUsed = 0;
  let researchIncludedCount = 0;
  const pendingResearchIncludes = [];

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    if (Date.now() > deadline) {
      for (const rest of batch.slice(i)) {
        deferredByDeadline++;
        dropped.push({
          urlHash: rest.urlHash,
          url: rest.link,
          reason: "deadline_deferred",
          sourceName: rest.sourceName,
        });
      }
      log(`deadline hit at ${i}/${batch.length}; ${batch.length - i} item(s) deferred to next run`);
      break;
    }
    const observed = buildObservedEvidence(item);
    let result;
    try {
      result = await moderateOne(item, items, promptBody, groups, observed);
    } catch (err) {
      result = {
        include: false,
        matchedRuleId: null,
        categoryId: null,
        reason: `error: ${String(err.message).slice(0, 200)}`,
        error: true,
        evidenceStatus: "insufficient",
      };
    }
    runAudit.modelReviewedCount++;

    if (
      result.evidenceStatus === "needs_verification" ||
      /^Forced reject: evidence/i.test(String(result.reason || ""))
    ) {
      evidenceForcedReject++;
    }
    const record = {
      runId,
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
      evidenceStatus: result.evidenceStatus || null,
      evidenceCitations: result.evidenceCitations || [],
      observedEvidence: observed,
      promptVersion,
      promptBodyHash: promptBodyHash(promptBody),
      ruleFingerprint,
      model,
      evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
    };
    const researchSlot = researchAdmission({
      include: result.include,
      categoryId: result.categoryId,
      sourceCategory: item.sourceCategory,
      researchIncludedCount: researchSlotsUsed,
      maxResearch,
    });
    if (researchSlot.deferred) {
      writeResearchEvent({
        event: "deferred",
        phase: "candidate_cap",
        urlHash: item.urlHash,
        url: item.link,
        reason: "research_share",
        record,
      });
      deferredByResearchShare++;
      quotaDeferredResearch.push({
        urlHash: item.urlHash,
        url: item.link,
        reason: "research_share",
        sourceName: item.sourceName,
        matchedRuleId: result.matchedRuleId,
        categoryId: result.categoryId,
        modelReason: result.reason,
      });
      runAudit.quotaDeferredCount = deferredByResearchShare;
      log(`DEFER ${item.sourceName} research share cap ${item.title.slice(0, 60)}`);
      continue;
    }
    researchSlotsUsed = researchSlot.researchIncludedCount;

    if (
      !result.error &&
      result.include &&
      countsAsResearch({ sourceCategory: item.sourceCategory, categoryId: result.categoryId })
    ) {
      writeResearchEvent({
        event: "pending",
        urlHash: item.urlHash,
        url: item.link,
        record,
      });
      pendingResearchIncludes.push({ item, record });
      runAudit.pendingResearchCount = pendingResearchIncludes.length;
      log(`HOLD ${item.sourceName} research include until run share is finalized`);
      continue;
    }
    const name = `${item.urlHash}.json`;
    if (result.error) {
      const errDir = path.join(ROOT, "decisions", "errors");
      writeJsonAtomic(path.join(errDir, name), record);
      errors++;
      runAudit.errorCount = errors;
    } else {
      const errFile = path.join(ROOT, "decisions", "errors", name);
      if (fs.existsSync(errFile)) fs.unlinkSync(errFile);
      writeJsonAtomic(uniqueJsonPath(contentDir, `${item.urlHash}-${Date.now()}.json`), record);
      decided++;
      if (result.include) included++;
      runAudit.decidedCount = decided;
      runAudit.includedCount = included;
      appendIndex(indexFile, [{ urlHash: item.urlHash, url: item.link, decidedAt }]);
    }
    // Ordinary decisions and retryable model errors need the same incremental
    // durability as research events; a hard Actions timeout skips finalizers.
    persistRunAudit(true);
    log(
      `${result.include ? "IN " : "OUT"} ${item.sourceName} ${result.evidenceStatus || "-"} ${result.matchedRuleId || "-"} ${item.title.slice(0, 60)}`,
    );
  }

  // Enforce the research share against actual accepted non-research items, not
  // just candidate counts. Deferred research remains unindexed for a later run.
  const finalResearchCap = researchCandidateCap({
    nonResearchCandidates: included,
    runLimit: FEED_MAX_NEW_PER_RUN,
    share: RESEARCH_RUN_SHARE_MAX,
  });
  for (let i = 0; i < pendingResearchIncludes.length; i++) {
    const { item, record } = pendingResearchIncludes[i];
    if (i >= finalResearchCap) {
      deferredByResearchShare++;
      const deferred = {
        urlHash: item.urlHash,
        url: item.link,
        reason: "research_share",
        sourceName: item.sourceName,
        matchedRuleId: record.matchedRuleId,
        categoryId: record.categoryId,
        modelReason: record.reason,
      };
      quotaDeferredResearch.push(deferred);
      runAudit.quotaDeferredCount = deferredByResearchShare;
      appendResearchEvent({
        event: "deferred",
        urlHash: item.urlHash,
        reason: "research_share",
        finalResearchCap,
        nonResearchIncluded: included,
      });
      runAudit.pendingResearchCount--;
      continue;
    }
    const errFile = path.join(ROOT, "decisions", "errors", `${item.urlHash}.json`);
    const hadErrorRecord = fs.existsSync(errFile);
    if (hadErrorRecord) fs.unlinkSync(errFile);
    const reviewFile = path.basename(uniqueJsonPath(contentDir, `${item.urlHash}-${Date.now()}.json`));
    writeJsonAtomic(path.join(contentDir, reviewFile), record);
    decided++;
    included++;
    researchIncludedCount++;
    runAudit.decidedCount = decided;
    runAudit.includedCount = included;
    appendIndex(indexFile, [{ urlHash: item.urlHash, url: item.link, decidedAt }]);
    appendResearchEvent({
      event: "admitted",
      urlHash: item.urlHash,
      reviewFile,
    });
    runAudit.pendingResearchCount--;
  }
  persistRunAudit();

  const runSummary = {
    runId,
    ranAt: decidedAt,
    finishedAt: new Date().toISOString(),
    model,
    promptVersion,
    promptBodyHash: promptBodyHash(promptBody),
    ruleFingerprint,
    evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
    rulesSkipped: skipped,
    sources: [...sourceStats.values()],
    discovered_unique: new Set(candidates.map((c) => c.urlHash)).size,
    candidates: candidates.length,
    afterSourceCap: capped.length,
    batch: batch.length,
    researchInBatch,
    maxResearch,
    finalResearchCap,
    researchIncluded: researchIncludedCount,
    pendingResearchJournal: path.relative(ROOT, pendingResearchJournal),
    pendingResearchCount: runAudit.pendingResearchCount,
    quotaDeferredResearch,
    quotaDeferredResearchCount: deferredByResearchShare,
    decided,
    included,
    errors,
    evidenceForcedReject,
    modelReviewedCount: runAudit.modelReviewedCount,
    deferredByDeadline,
    deferredByResearchShare,
    modelReviewed: runAudit.modelReviewedCount,
    notReviewed: dropped,
    // notReviewed vs decided: items in notReviewed never entered the model;
    // decided items have include true|false records under content-reviews/.
  };
  writeJsonAtomic(
    uniqueJsonPath(runsDir, `${Date.now()}.json`),
    runSummary,
  );
  persistRunAudit(true);
  log(`done included=${included}/${batch.length} decided=${decided} notReviewed=${dropped.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    try {
      const abortDir = path.join(ROOT, "decisions", "content-runs");
      fs.mkdirSync(abortDir, { recursive: true });
      writeJsonAtomic(
        uniqueJsonPath(abortDir, `${Date.now()}-aborted.json`),
        {
          runId: runAudit.runId,
          aborted: true,
          error: String(err.message || err).slice(0, 500),
          abortedAt: new Date().toISOString(),
          decidedCount: runAudit.decidedCount,
          includedCount: runAudit.includedCount,
          quotaDeferredCount: runAudit.quotaDeferredCount,
          errorCount: runAudit.errorCount,
          modelReviewedCount: runAudit.modelReviewedCount,
          batchSize: runAudit.batchSize,
          notReviewedCount: runAudit.notReviewedCount,
          pendingResearchCount: runAudit.pendingResearchCount,
          pendingResearchJournal: runAudit.pendingResearchJournal
            ? path.relative(ROOT, runAudit.pendingResearchJournal)
            : null,
          // Research decisions still awaiting quota settlement are in the
          // run-scoped JSONL journal referenced above.
        },
      );
    } catch {
      /* best-effort abort record */
    }
      if (process.env.GITHUB_ACTIONS === "true") {
        const persisted = commitPaths(
          ["decisions"],
          `chore: checkpoint aborted content audit ${runAudit.runId || "startup"}`,
        );
        if (!persisted.ok) {
          console.error("[pipeline] abort audit checkpoint failed:", persisted.error);
        }
      }
    process.exit(1);
  });
