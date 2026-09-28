#!/usr/bin/env node
/**
 * Governance cycle: settle previous voting batch, then pre-review new proposals.
 * Voting math freezes at voting entry (starsAtVotingStart / quorumAtVotingStart).
 * Vote deadline = this settle run. Account age ≥ MIN_ACCOUNT_AGE_DAYS required.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getRepo,
  resolveUserCreatedAts,
  listOpenIssuesWithLabel,
  listIssues,
  listIssuesCreatedOnDay,
  listIssueReactions,
  setLabels,
  commentOnce,
  closeIssue,
  upsertFilePr,
  getPull,
  listPulls,
  mergePullRequest,
  pullIsMerged,
  isCommitReachableFromRef,
  splitSlug,
  repoSlug,
} from "../lib/github.mjs";
import { stageForStars, quorumForStars, canAutoMerge, AUTO_MERGE_MIN_STARS, MIN_ACCOUNT_AGE_DAYS, LABELS, RULE_MAX_CHARS, RULE_MAX_CHARS_GROUP, isCategory, isGroupRule, FOUNDER_LOGIN, FOUNDER_STAR_CEILING } from "../lib/constants.mjs";
import { tallyVotes, settleOutcome, applyFounderVote, filterReactionsByWindow, pickVoteWindow, extractReactionList, normalizeModelVerdict, prMatchesFrozenIdentity, prHeadMatchesFrozen, countsTowardProposalQuota, hasFrozenTerminal, missingTargetDisposition, latestFrozenVerdict, snapshotFreezeDisposition, rulesDependentGateDisposition, snapshotRebuildableFrom, sortDecisionRecordsByEventTime, accountAgeVoteLogins } from "../lib/voting.mjs";
import { commitPaths, syncWithOrigin } from "../lib/git-commit.mjs";
import {
  settlementCommentIdentity,
  settlementCommentMarker,
} from "../lib/settlement-comments.mjs";
import {
  parseEvidenceContractSection,
  normalizeEvidenceContract,
  contractForRuleBuild,
  EVIDENCE_ENGINE_VERSION,
} from "../lib/evidence.mjs";
import { chatJSON, loadPrompt, fillTemplate, sanitizeUntrusted } from "../lib/llm.mjs";
import {
  loadActiveRules,
  reservedRuleIds,
  ruleIdsFromBranches,
  findRuleFile,
  parseTargetRule,
  parseProposalType,
  parseTargetGroup,
  parseCategory,
  parseRuleText,
  evaluateProposalBody,
  evaluateProposalQuota,
  startOfUtcDay,
  filterCreatedOnUtcDay,
  buildRuleFile,
  evidenceMetaFromRuleFile,
  nextFreeItemNumber,
} from "../lib/rules.mjs";
import { scanRuleText } from "../lib/rule-guard.mjs";

const ROOT = process.cwd();
const decisionsDir = path.join(ROOT, "decisions", "rule-reviews");
const snapshotsDir = path.join(ROOT, "decisions", "rule-snapshots");

function log(...args) {
  console.log("[governance]", ...args);
}

function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** Never overwrite an existing decision — same-ms writes get a numeric suffix. */
function uniqueDecisionFile(name) {
  let file = path.join(decisionsDir, name);
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length || undefined);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(decisionsDir, `${base}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(decisionsDir, `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

function writeDecision(name, payload) {
  writeJsonAtomic(uniqueDecisionFile(name), payload);
}

/**
 * Push decision files to origin before an irreversible GitHub side effect
 * (merge / create PR / close). If persistence fails the caller must NOT
 * perform the side effect — otherwise a killed job leaves GitHub changed
 * with no frozen record to resume from.
 */
function persistDecisions(label) {
  const res = commitPaths(["decisions"], `chore: persist decisions before ${label}`);
  log(`persistDecisions(${label}):`, JSON.stringify(res));
  return Boolean(res.ok);
}

function snapshotPath(issueNumber) {
  return path.join(snapshotsDir, `${issueNumber}.json`);
}

function writeSnapshot(issueNumber, payload) {
  writeJsonAtomic(snapshotPath(issueNumber), payload);
}

function loadSnapshot(issueNumber) {
  return readJsonFile(snapshotPath(issueNumber));
}

function readJsonFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Newest→oldest scan for the first parseable decision file.
 * A truncated/corrupt newest record must never erase a frozen settlement —
 * fall back to the most recent valid record instead of returning null.
 */
function latestParseableDecision(files) {
  for (let i = files.length - 1; i >= 0; i--) {
    const rec = readJsonFile(path.join(decisionsDir, files[i]));
    if (rec) return rec;
  }
  return null;
}

/**
 * Rebuild a lost rule-snapshot from the frozen pre-review `pass` decision's
 * embedded `snapshot` fields. Never re-parses the live issue body (edits after
 * pre-review must not change the frozen rule). Returns the payload or null.
 */
function rebuildSnapshotFromFrozenPass(issueNumber, priorPass) {
  if (!snapshotRebuildableFrom(priorPass)) return null;
  const src = priorPass.snapshot;
  const payload = {
    ...src,
    issueNumber,
    recoveredFrom: "frozen_pre_review_pass",
    recoveredAt: new Date().toISOString(),
  };
  writeSnapshot(issueNumber, payload);
  return payload;
}

/**
 * Explicit manual-handling marker for an unrecoverable lost snapshot.
 * Written once per issue so the proposal does not silently defer forever.
 */
async function markSnapshotNeedsManual(issueNumber, priorPass) {
  const markerPrefix = `needs-manual-${issueNumber}-`;
  const commentPrefix = `needs-manual-commented-${issueNumber}-`;
  const alreadyNotified = hasDecisionPrefix(commentPrefix);
  if (hasDecisionPrefix(markerPrefix) && alreadyNotified) return false;
  if (!hasDecisionPrefix(markerPrefix)) {
    writeDecision(`needs-manual-${issueNumber}-${Date.now()}.json`, {
      issueNumber,
      reason: "snapshot_lost_unrecoverable",
      frozenPassAt: priorPass?.reviewedAt || null,
      action: "restore decisions/rule-snapshots/<issue>.json from history or re-file the proposal",
      at: new Date().toISOString(),
    });
  }
  // Notify until the comment is known-delivered — a marker alone must not
  // silence retries after a failed comment.
  if (!alreadyNotified) {
    try {
      await commentOnce(
        issueNumber,
        `<!-- aicanonfeed-needs-manual:${issueNumber}:snapshot-lost -->`,
        `⚠️ Proposal #${issueNumber} cannot proceed automatically: the frozen pre-review snapshot is missing and cannot be rebuilt from decision records.\n\n` +
          `A maintainer must restore \`decisions/rule-snapshots/${issueNumber}.json\` (from git history) or re-file the proposal.`,
      );
      writeDecision(`needs-manual-commented-${issueNumber}-${Date.now()}.json`, {
        issueNumber,
        reason: "snapshot_lost_unrecoverable",
        at: new Date().toISOString(),
      });
    } catch (err) {
      log(`needs-manual #${issueNumber} comment failed:`, String(err.message || err));
      return true;
    }
  }
  return true;
}

/** Canonical form of an evidence contract for snapshot-vs-live comparison. */
function normalizeContract(contract) {
  return normalizeEvidenceContract(contract);
}

/** Latest pre-review decision for an issue (for error-comment dedupe). */
function latestPreReview(issueNumber) {
  if (!fs.existsSync(decisionsDir)) return null;
  const files = fs
    .readdirSync(decisionsDir)
    .filter(
      (f) =>
        (f.startsWith(`pre-review-${issueNumber}-`) ||
          f.startsWith(`pre-review-commit-error-${issueNumber}-`)) &&
        f.endsWith(".json"),
    )
    .sort();
  return latestParseableDecision(files);
}

/**
 * Latest frozen pass/reject for an issue. Tooling `verdict: "error"` records
 * must never shadow a frozen decision — otherwise a snapshot-commit failure
 * after `pass` would force a re-judge next cycle (same class as empty-reason
 * reject skips).
 */
function latestFrozenPreReview(issueNumber) {
  if (!fs.existsSync(decisionsDir)) return null;
  const files = fs
    .readdirSync(decisionsDir)
    .filter(
      (f) =>
        (f.startsWith(`pre-review-${issueNumber}-`) ||
          f.startsWith(`pre-review-commit-error-${issueNumber}-`)) &&
        f.endsWith(".json"),
    )
    .sort();
  const recs = [];
  for (const f of files) {
    try {
      recs.push(JSON.parse(fs.readFileSync(path.join(decisionsDir, f), "utf8")));
    } catch {
      /* ignore */
    }
  }
  return latestFrozenVerdict(recs);
}

/**
 * Latest settlement record for an issue (excludes settlement-snapshot-*).
 * A settlement on an issue still labeled `voting` means side effects did not
 * finish — the next cycle must complete them, never re-tally.
 */
function latestSettlement(issueNumber) {
  if (!fs.existsSync(decisionsDir)) return null;
  const files = fs
    .readdirSync(decisionsDir)
    .filter(
      (f) =>
        f.startsWith(`settlement-${issueNumber}-`) &&
        !f.startsWith(`settlement-snapshot-${issueNumber}-`) &&
        f.endsWith(".json"),
    )
    .sort();
  return latestParseableDecision(files);
}

/**
 * Latest settlement-snapshot-* decision (has prNumber/branch after a ratified PR).
 * Distinct from loadSnapshot(), which is the pre-review freeze in rule-snapshots/.
 */
function latestSettlementSnapshot(issueNumber) {
  if (!fs.existsSync(decisionsDir)) return null;
  const files = fs
    .readdirSync(decisionsDir)
    .filter((f) => f.startsWith(`settlement-snapshot-${issueNumber}-`) && f.endsWith(".json"))
    .sort();
  return latestParseableDecision(files);
}

/** prNumber for a pending rule: settlement record first, then settlement-snapshot. */
function settlementPrNumber(issueNumber) {
  const settle = latestSettlement(issueNumber);
  if (settle?.prNumber) return settle.prNumber;
  const snap = latestSettlementSnapshot(issueNumber);
  return snap?.prNumber || null;
}

/** Frozen PR head SHA (content identity) from settlement records. */
function settlementPrHeadSha(issueNumber) {
  const settle = latestSettlement(issueNumber);
  if (settle?.prHeadSha) return settle.prHeadSha;
  const snap = latestSettlementSnapshot(issueNumber);
  return snap?.prHeadSha || null;
}

/** Frozen PR routing identity; legacy records derive the branch from nextId. */
function settlementPrIdentity(issueNumber) {
  const settle = latestSettlement(issueNumber) || {};
  const snap = latestSettlementSnapshot(issueNumber) || {};
  let currentRepo = {};
  try {
    currentRepo = splitSlug();
  } catch {
    /* identity validation will fail closed below */
  }
  const nextId = settle.nextId || snap.ruleId || snap.targetRuleId || null;
  return {
    headRef:
      settle.prBranch ||
      settle.prRequest?.branch ||
      snap.branch ||
      (nextId ? `rule/${nextId}-from-${issueNumber}` : null),
    baseOwner: settle.prBaseOwner || settle.prRequest?.owner || snap.baseOwner || currentRepo.owner || null,
    baseRepo: settle.prBaseRepo || settle.prRequest?.repo || snap.baseRepo || currentRepo.repo || null,
    baseRef: settle.prBaseRef || settle.prRequest?.base || snap.baseRef || "main",
  };
}

function prMatchesSettlementIdentity(pr, issueNumber, expectedNumber = null) {
  const identity = settlementPrIdentity(issueNumber);
  if (!identity.headRef || !identity.baseOwner || !identity.baseRepo || !identity.baseRef) {
    return false;
  }
  return prMatchesFrozenIdentity(pr, {
    expectedNumber,
    baseOwner: identity.baseOwner,
    baseRepo: identity.baseRepo,
    expectedHeadRef: identity.headRef,
    expectedBaseRef: identity.baseRef,
  });
}

/**
 * Rule ids already frozen into settlement records (including PR-pending ones
 * where upsertFilePr has not succeeded yet). Must be reserved so a later
 * proposal in the same cycle cannot allocate the same nextId.
 */
function frozenNextIds() {
  const ids = new Set();
  if (!fs.existsSync(decisionsDir)) return ids;
  for (const f of fs.readdirSync(decisionsDir)) {
    if (!f.startsWith("settlement-") || f.startsWith("settlement-snapshot-") || !f.endsWith(".json")) {
      continue;
    }
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(decisionsDir, f), "utf8"));
      if (rec?.nextId) ids.add(String(rec.nextId));
      if (rec?.prRequest?.path) {
        const m = String(rec.prRequest.path).match(/(\d+-\d+)\.md$/);
        if (m) ids.add(m[1]);
      }
    } catch {
      /* ignore */
    }
  }
  return ids;
}

function labelForOutcome(outcome) {
  return outcome === "ratified"
    ? LABELS.ratified
    : outcome === "ratified_pending_merge"
      ? LABELS.pendingMerge
      : outcome === "defeated"
        ? LABELS.defeated
        : outcome === "expired_no_quorum"
          ? LABELS.expired
          : outcome === "ratified_pr_abandoned"
            ? LABELS.doNotMerge
            : LABELS.rejected;
}

/** Merge frozen vote fields from the prior settlement so recover records stay auditable. */
function inheritVoteFields(issueNumber, extra = {}) {
  const prior = latestSettlement(issueNumber) || {};
  const snap = latestSettlementSnapshot(issueNumber) || {};
  return {
    ...extra,
    issueNumber,
    votes: extra.votes ?? prior.votes ?? null,
    stars: extra.stars ?? prior.stars ?? prior.starsAtVotingStart ?? null,
    starsAtVotingStart: extra.starsAtVotingStart ?? prior.starsAtVotingStart ?? null,
    liveStars: extra.liveStars ?? prior.liveStars ?? null,
    stage: extra.stage ?? prior.stage ?? null,
    quorum: extra.quorum ?? prior.quorum ?? null,
    quorumAtVotingStart: extra.quorumAtVotingStart ?? prior.quorumAtVotingStart ?? null,
    voteDeadline: extra.voteDeadline ?? prior.voteDeadline ?? null,
    voteDeadlineAt: extra.voteDeadlineAt ?? prior.voteDeadlineAt ?? null,
    founderVote: extra.founderVote ?? prior.founderVote ?? null,
    founderLogin: extra.founderLogin ?? prior.founderLogin ?? null,
    minAccountAgeDays: extra.minAccountAgeDays ?? prior.minAccountAgeDays ?? null,
    // The public tally must survive outcome rewrites (e.g. PR closed after ratify).
    voteOutcome: extra.voteOutcome ?? prior.voteOutcome ?? null,
    // PR routing identity must survive every rewrite — recover cannot proceed
    // from a record that dropped these fields.
    nextId: extra.nextId ?? prior.nextId ?? snap.ruleId ?? snap.targetRuleId ?? null,
    prType: extra.prType ?? prior.prType ?? null,
    prNumber: extra.prNumber ?? prior.prNumber ?? snap.prNumber ?? null,
    prHeadSha: extra.prHeadSha ?? prior.prHeadSha ?? snap.prHeadSha ?? null,
    prBranch:
      extra.prBranch ??
      prior.prBranch ??
      prior.prRequest?.branch ??
      snap.branch ??
      null,
    prBaseOwner: extra.prBaseOwner ?? prior.prBaseOwner ?? prior.prRequest?.owner ?? snap.baseOwner ?? null,
    prBaseRepo: extra.prBaseRepo ?? prior.prBaseRepo ?? prior.prRequest?.repo ?? snap.baseRepo ?? null,
    prBaseRef: extra.prBaseRef ?? prior.prBaseRef ?? prior.prRequest?.base ?? snap.baseRef ?? "main",
    evidenceEngineVersion:
      extra.evidenceEngineVersion ?? prior.evidenceEngineVersion ?? null,
  };
}

async function markPrIntegrityNeedsManual({
  issueNumber,
  prNumber,
  frozenSha,
  currentSha,
  reason,
}) {
  const wasMerged =
    String(reason || "").includes("merged") ||
    String(reason || "").startsWith("merge_state_confirmed");
  const manualStage = wasMerged ? "merged" : "open";
  const markerPrefix = `needs-manual-pr-${issueNumber}-${manualStage}-`;
  const commentPrefix = `needs-manual-pr-commented-${issueNumber}-${manualStage}-`;
  if (!hasDecisionPrefix(markerPrefix)) {
    writeDecision(`needs-manual-pr-${issueNumber}-${manualStage}-${Date.now()}.json`, {
      issueNumber,
      prNumber,
      reason,
      frozenSha: frozenSha || null,
      currentSha: currentSha || null,
      action: wasMerged
        ? "maintainer must verify the merged rule against the frozen proposal"
        : "maintainer must inspect the PR before it can be merged",
      at: new Date().toISOString(),
    });
  }
  if (!persistDecisions(`manual-pr-review-${prNumber}`)) return false;
  if (!hasDecisionPrefix(commentPrefix)) {
    try {
      await commentOnce(
        issueNumber,
        `<!-- aicanonfeed-needs-manual-pr:${issueNumber}:${prNumber}:${manualStage}:${encodeURIComponent(reason || "unknown")} -->`,
        wasMerged
          ? `⚠️ PR #${prNumber} was merged, but its head or target failed the frozen identity check (\`${reason || "unknown"}\`; expected head \`${frozenSha || "unknown"}\`, observed \`${currentSha || "unknown"}\`). The bot will not mark this proposal ratified automatically. A maintainer must inspect the merged rule.`
          : `⚠️ PR #${prNumber} does not have a verifiable frozen head or target identity (\`${reason || "unknown"}\`; expected head \`${frozenSha || "unknown"}\`, observed \`${currentSha || "unknown"}\`). The bot will not merge it automatically. A maintainer must inspect the PR.`,
      );
      writeDecision(`needs-manual-pr-commented-${issueNumber}-${manualStage}-${Date.now()}.json`, {
        issueNumber,
        prNumber,
        at: new Date().toISOString(),
      });
      persistDecisions(`manual-pr-comment-${prNumber}`);
    } catch (err) {
      log(`manual PR review #${issueNumber} comment failed:`, String(err.message || err));
    }
  }
  return true;
}

/** Apply labels, then comment, then close only after the comment is delivered. */
async function applySettlementSideEffects({
  issue,
  label,
  removeLabels = [],
  commentText,
  shouldClose = true,
  outcome,
  via = "settle",
}) {
  let commentOk = !commentText;
  try {
    await setLabels(issue.number, [label], removeLabels);
  } catch (err) {
    writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
      issueNumber: issue.number,
      outcome,
      via,
      error: String(err.message || err).slice(0, 300),
      at: new Date().toISOString(),
    });
    return { labelsOk: false };
  }
  if (commentText) {
    try {
      const settlement = latestSettlement(issue.number) || { outcome };
      await deliverSettlementComment(issue.number, settlement, commentText, via);
      commentOk = true;
    } catch (err) {
      log(`side-effects #${issue.number} comment failed:`, String(err.message || err));
      writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome,
        label,
        via,
        phase: "comment",
        error: String(err.message || err).slice(0, 300),
        at: new Date().toISOString(),
      });
    }
  }
  if (shouldClose && commentOk) {
    try {
      await closeIssue(issue.number);
    } catch (err) {
      log(`side-effects #${issue.number} close failed:`, String(err.message || err));
      writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome,
        label,
        via,
        phase: "close",
        error: String(err.message || err).slice(0, 300),
        at: new Date().toISOString(),
      });
    }
  }
  return { labelsOk: true, commentOk };
}

/**
 * Frozen vote deadline for an issue. The first settle attempt (including a
 * lookup-failed defer) freezes `voteDeadlineAt`; later cycles must not count
 * reactions that arrived after that instant. A `voteDeadlineReset` record
 * (written when voting is re-opened) clears prior deadlines.
 */
function voteDeadlineRecords(issueNumber) {
  if (!fs.existsSync(decisionsDir)) return [];
  const files = fs
    .readdirSync(decisionsDir)
    .filter(
      (f) =>
        (f.startsWith(`settle-vote-deadline-${issueNumber}-`) ||
          f.startsWith(`settle-deferred-${issueNumber}-`) ||
          f.startsWith(`settlement-${issueNumber}-`)) &&
        !f.startsWith(`settlement-snapshot-${issueNumber}-`) &&
        f.endsWith(".json"),
    )
    .sort();
  const recs = [];
  for (const f of files) {
    try {
      recs.push(JSON.parse(fs.readFileSync(path.join(decisionsDir, f), "utf8")));
    } catch {
      /* ignore unreadable record */
    }
  }
  return sortDecisionRecordsByEventTime(recs);
}

/** Clear any frozen vote deadline (called when voting is re-opened). */
function resetVoteDeadline(issueNumber, reason) {
  writeDecision(`settle-vote-deadline-${issueNumber}-${Date.now()}.json`, {
    issueNumber,
    voteDeadlineReset: true,
    reason: String(reason || "").slice(0, 200),
    resetAt: new Date().toISOString(),
  });
}

/**
 * Open a fresh voting window. Clears any prior deadline and freezes the
 * window start so re-opened voting cannot count reactions from the previous
 * window (or from before this proposal entered voting).
 */
function openVoteWindow(issueNumber, reason) {
  writeDecision(`settle-vote-deadline-${issueNumber}-${Date.now()}.json`, {
    issueNumber,
    voteDeadlineReset: true,
    voteWindowStartAt: new Date().toISOString(),
    reason: String(reason || "").slice(0, 200),
    resetAt: new Date().toISOString(),
  });
}

/**
 * Ensure a voting window exists without discarding votes already cast.
 * Resume after a failed label switch must keep the original window start —
 * a reset would drop every reaction between the first open and the resume.
 */
function ensureVoteWindow(issueNumber, reason) {
  const records = voteDeadlineRecords(issueNumber);
  const existing = pickVoteWindow(records);
  if (existing.startAt) {
    log(`keep existing vote window for #${issueNumber} start=${existing.startAt}`);
    return { opened: false, startAt: existing.startAt };
  }
  openVoteWindow(issueNumber, reason);
  return { opened: true, startAt: new Date().toISOString() };
}

function ruleFileName(id) {
  return `rules/${id}.md`;
}

function guardRule({ text, category, nextId, existingIds, maxChars = RULE_MAX_CHARS }) {
  if (!text || text.length < 20) return "Rule text too short";
  if (text.length > maxChars) return "Rule text too long";
  // Same markup guard as upsertFilePr (lib/github.mjs).
  if (/<script|javascript:|onerror=|onload=/i.test(text)) return "Rule text contains unsafe markup";
  const unsafe = scanRuleText(text);
  if (unsafe) return `Rule text rejected (${unsafe})`;
  if (!isCategory(category)) return "Invalid category";
  if (existingIds.has(nextId)) return `Rule ID ${nextId} already exists`;
  return null;
}

const voteAccountAgeCache = new Map();
let voteAccountAgeDeadline = null;
const VOTE_ACCOUNT_AGE_LOOKUP_BUDGET_MS = 120_000;

/** Share one bounded lookup budget across every voting issue in this cycle. */
async function resolveCreatedAt(reactions, authorLogin) {
  const logins = accountAgeVoteLogins(reactions, authorLogin);
  if (voteAccountAgeDeadline === null) {
    voteAccountAgeDeadline = Date.now() + VOTE_ACCOUNT_AGE_LOOKUP_BUDGET_MS;
  }
  const uniqueLogins = [...new Set(logins)];
  const uncached = uniqueLogins.filter((login) => !voteAccountAgeCache.has(login));
  if (uncached.length) {
    const fetched = await resolveUserCreatedAts(uncached, {
      timeoutMs: Math.max(0, voteAccountAgeDeadline - Date.now()),
    });
    for (const [login, result] of fetched) voteAccountAgeCache.set(login, result);
  }
  return new Map(
    uniqueLogins.map((login) => [
      login,
      voteAccountAgeCache.get(login) || {
        ok: false,
        createdAt: null,
        reason: "lookup_failed",
      },
    ]),
  );
}

async function settlePhase({ stars, stageInfo, reservedIds, rulesFresh = true }) {
  const voting = await listOpenIssuesWithLabel(LABELS.voting);
  log(`settle: ${voting.length} voting issue(s), quorum=${stageInfo.quorum}`);
  const results = [];
  const { owner, repo } = splitSlug();
  // Include on-disk ids and open-PR branch ids so pending rules cannot be reallocated.
  const usedIds = new Set(reservedIds);

  for (const issue of voting) {
    try {
    let prNumber = null;
    let prUrl = null;
    let skippedMerge = false;
    let guardError = null;
    // Prefer resuming a frozen settlement over re-tallying. A settlement record
    // on an issue still labeled `voting` means labels/comment/close did not finish.
    const prior = latestSettlement(issue.number);
    if (prior?.outcome) {
      // Vote is frozen. If PR was never created (upsertFilePr failed after the
      // freeze), retry creation from prRequest — do NOT complete a pending-merge
      // transfer with no PR (that sticks forever on no_pr_found).
      if (prior.prPending && !prior.prNumber && prior.prRequest) {
        log(`settle: #${issue.number} resume frozen vote — retrying PR creation`);
        try {
          // Prefer a PR already recorded in settlement-snapshot (written when
          // upsertFilePr succeeded) so a crash after create never opens #2.
          const knownPrNumber = settlementPrNumber(issue.number);
          let pr = null;
          if (knownPrNumber) {
            try {
              pr = await getPull(knownPrNumber);
              if (
                !prMatchesFrozenIdentity(pr, {
                  expectedNumber: knownPrNumber,
                  baseOwner: owner,
                  baseRepo: repo,
                  expectedHeadRef: prior.prRequest.branch,
                  expectedBaseRef: prior.prRequest.base || "main",
                })
              ) {
                throw new Error(`PR #${knownPrNumber} does not match the frozen PR request`);
              }
            } catch {
              throw new Error(`Cannot verify frozen PR #${knownPrNumber}`);
            }
          }
          if (!pr) {
            if (!persistDecisions(`retry-pr-${issue.number}`)) {
              throw new Error("decision persistence failed — not creating PR");
            }
            pr = await upsertFilePr(prior.prRequest);
          }
          if (
            !prMatchesFrozenIdentity(pr, {
              expectedNumber: pr.number,
              baseOwner: owner,
              baseRepo: repo,
              expectedHeadRef: prior.prRequest.branch,
              expectedBaseRef: prior.prRequest.base || "main",
            })
          ) {
            throw new Error(`PR #${pr.number} does not match the frozen PR request`);
          }
          const prHeadSha = pr.head?.sha || null;
          writeDecision(`settlement-snapshot-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            proposalType: prior.prType || prior.prRequest?.prType || null,
            ruleId: prior.nextId || null,
            prNumber: pr.number,
            prHeadSha,
            prBranch: prior.prRequest.branch,
            prBaseOwner: owner,
            prBaseRepo: repo,
            prBaseRef: prior.prRequest.base || "main",
            branch: prior.prRequest.branch,
            baseOwner: owner,
            baseRepo: repo,
            baseRef: prior.prRequest.base || "main",
            snapshotAt: new Date().toISOString(),
          });
          writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
            ...prior,
            prNumber: pr.number,
            prHeadSha,
            prBranch: prior.prRequest.branch,
            prBaseOwner: owner,
            prBaseRepo: repo,
            prBaseRef: prior.prRequest.base || "main",
            prPending: false,
            skippedMerge: true,
            prRequest: null,
            outcome: "ratified_pending_merge",
            resumedAt: new Date().toISOString(),
          });
          if (!persistDecisions(`freeze-retried-pr-${pr.number}`)) {
            throw new Error("decision persistence failed — not finishing PR");
          }
          // Finish merge attempt / kill-switch check on the new PR.
          // finishPr mutates the local `skippedMerge` — that is the live outcome.
          skippedMerge = false;
          try {
            await finishPr({
              issue,
              prNumber: pr.number,
              nextId: prior.nextId || prior.prRequest?.branch || "rule",
              type: prior.prType || "new",
            });
          } catch (err) {
            skippedMerge = true;
            log(`settle #${issue.number} resume finishPr failed:`, String(err.message || err));
          }
          // Write the authoritative result AFTER finishPr so the merge outcome
          // is recorded, not the provisional `skippedMerge: true` above.
          const finalOutcome = skippedMerge ? "ratified_pending_merge" : "ratified";
          writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
            ...prior,
            prNumber: pr.number,
            prHeadSha,
            prBranch: prior.prRequest.branch,
            prBaseOwner: owner,
            prBaseRepo: repo,
            prBaseRef: prior.prRequest.base || "main",
            prPending: false,
            prRequest: null,
            skippedMerge,
            outcome: finalOutcome,
            resumedAt: new Date().toISOString(),
          });
          if (!persistDecisions(`retry-settlement-${issue.number}`)) {
            throw new Error("decision persistence failed — not updating issue labels");
          }
          const resumeLabel = labelForOutcome(finalOutcome);
          try {
            await setLabels(issue.number, [resumeLabel], [LABELS.voting, LABELS.proposal]);
          } catch (err) {
            // PR already exists — do not report this as a PR-create failure.
            writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
              issueNumber: issue.number,
              outcome: finalOutcome,
              resumed: true,
              error: String(err.message || err).slice(0, 300),
              at: new Date().toISOString(),
            });
            results.push({
              issueNumber: issue.number,
              outcome: finalOutcome,
              resumed: true,
              prNumber: pr.number,
              labelsOk: false,
            });
            continue;
          }
          // Comment/close must not flip a successful PR create into "retry failed".
          let commentDelivered = false;
          try {
            const resumedSettlement = {
              ...prior,
              outcome: finalOutcome,
            };
            await deliverSettlementComment(
              issue.number,
              resumedSettlement,
              `### Settlement — ${finalOutcome} (resumed)\n\n- PR #${pr.number} created from the frozen vote result; votes were **not** re-tallied.`,
              "retry_pr",
            );
            commentDelivered = true;
          } catch (err) {
            log(`settle #${issue.number} resume comment failed:`, String(err.message || err));
            writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
              issueNumber: issue.number,
              outcome: finalOutcome,
              label: resumeLabel,
              phase: "comment",
              error: String(err.message || err).slice(0, 300),
              at: new Date().toISOString(),
            });
          }
          if (finalOutcome !== "ratified_pending_merge" && commentDelivered) {
            try {
              await closeIssue(issue.number);
            } catch (err) {
              log(`settle #${issue.number} resume close failed:`, String(err.message || err));
              writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
                issueNumber: issue.number,
                outcome: finalOutcome,
                label: resumeLabel,
                phase: "close",
                error: String(err.message || err).slice(0, 300),
                at: new Date().toISOString(),
              });
            }
          }
          writeDecision(`settle-resumed-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: finalOutcome,
            resumed: true,
            prNumber: pr.number,
            at: new Date().toISOString(),
          });
          results.push({
            issueNumber: issue.number,
            outcome: finalOutcome,
            resumed: true,
            prNumber: pr.number,
          });
          continue;
        } catch (err) {
          // Only PR creation / finishPr failures land here — comment/close above
          // are already isolated. Stay in `voting` for a later cycle.
          log(`settle: #${issue.number} PR retry failed (stay in voting):`, String(err.message || err));
          writeDecision(`settle-pr-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
          results.push({
            issueNumber: issue.number,
            outcome: "ratified_pending_merge",
            resumed: true,
            prRetryFailed: true,
          });
          continue;
        }
      }
      const resumeLabel = labelForOutcome(prior.outcome);
      log(`settle: #${issue.number} resume frozen outcome=${prior.outcome} (no re-tally)`);
      try {
        await setLabels(issue.number, [resumeLabel], [LABELS.voting, LABELS.proposal]);
      } catch (err) {
        writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome: prior.outcome,
          resumed: true,
          error: String(err.message || err).slice(0, 300),
          at: new Date().toISOString(),
        });
        results.push({
          issueNumber: issue.number,
          outcome: prior.outcome,
          resumed: true,
          error: String(err.message || err).slice(0, 200),
        });
        continue;
      }
      const resumeSummary = [
        `### Settlement — ${prior.outcome} (resumed)`,
        "",
        `- 👍 ${prior.votes?.up ?? "?"} / 👎 ${prior.votes?.down ?? "?"} (void ${prior.votes?.voided ?? "?"}, valid ${prior.votes?.valid ?? "?"})`,
        `- quorum (approve-count): ${prior.quorum ?? "?"} · starsAtVotingStart ${prior.starsAtVotingStart ?? prior.stars ?? "?"} · stage ${prior.stage ?? "?"}`,
        `- vote deadline: settle run that froze this result (reactions after are not counted)`,
        prior.prNumber ? `- PR: #${prior.prNumber}` : "",
        `- **resumed:** side effects completed on a later cycle from the frozen settlement record; votes were not re-tallied.`,
      ]
        .filter(Boolean)
        .join("\n");
      let commentDelivered = hasSettlementComment(issue.number, prior);
      if (!commentDelivered) {
        try {
          await deliverSettlementComment(issue.number, prior, resumeSummary, "resume");
          commentDelivered = true;
        } catch (err) {
          log(`settle #${issue.number} resume comment failed:`, String(err.message || err));
          writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: prior.outcome,
            label: resumeLabel,
            phase: "comment",
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
        }
      }
      if (prior.outcome !== "ratified_pending_merge" && commentDelivered) {
        try {
          await closeIssue(issue.number);
        } catch (err) {
          log(`settle #${issue.number} resume close failed:`, String(err.message || err));
          writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: prior.outcome,
            label: resumeLabel,
            phase: "close",
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
        }
      }
      writeDecision(`settle-resumed-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome: prior.outcome,
        resumed: true,
        prNumber: prior.prNumber ?? null,
        at: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, outcome: prior.outcome, resumed: true });
      continue;
    }
    // Load (or recover) the pre-review snapshot BEFORE vote math so quorum and
    // starsAtVotingStart come from the frozen voting entry, not live fallbacks.
    let snap0 = loadSnapshot(issue.number);
    let snapComplete = Boolean(snap0 && snap0.proposalType && snap0.ruleText);
    if (!snapComplete) {
      const frozenPassRec = latestFrozenPreReview(issue.number);
      const hasFrozenPass = frozenPassRec?.verdict === "pass";
      // Frozen pass + lost snapshot is tooling failure: try rebuild from the
      // frozen decision's embedded snapshot fields; never re-parse the body.
      if (snapshotFreezeDisposition({ hasFrozenPass, snapshotComplete: false }) === "defer") {
        const rebuilt = rebuildSnapshotFromFrozenPass(issue.number, frozenPassRec);
        if (rebuilt) {
          const snapRel = path.relative(ROOT, snapshotPath(issue.number));
          const rebuildCommit = commitPaths(
            [snapRel],
            `chore: rebuild lost pre-review snapshot #${issue.number}`,
          );
          if (rebuildCommit.ok) {
            log(`settle #${issue.number} rebuilt lost snapshot from frozen pass`);
            snap0 = rebuilt;
            snapComplete = true;
          } else {
            writeDecision(`settle-deferred-${issue.number}-${Date.now()}.json`, {
              issueNumber: issue.number,
              outcome: "deferred_snapshot_rebuild",
              reason: "snapshot_rebuild_commit_failed",
              error: String(rebuildCommit.error || "").slice(0, 200),
              deferredAt: new Date().toISOString(),
            });
            results.push({
              issueNumber: issue.number,
              outcome: "deferred_snapshot_rebuild",
            });
            continue;
          }
        } else {
          await markSnapshotNeedsManual(issue.number, frozenPassRec);
          results.push({ issueNumber: issue.number, outcome: "needs_manual" });
          continue;
        }
      }
      // No frozen pass + incomplete snapshot: block BEFORE tally. A manual
      // `voting` label must not become expired_no_quorum / defeated either.
      if (!snapComplete) {
        writeDecision(`settle-deferred-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome: "deferred_snapshot_missing",
          reason: "no_frozen_pass_incomplete_snapshot",
          deferredAt: new Date().toISOString(),
        });
        results.push({
          issueNumber: issue.number,
          outcome: "deferred_snapshot_missing",
        });
        continue;
      }
    }
    // Quorum + F1 freeze at voting entry (starsAtVotingStart). Fall back to live stars for legacy issues.
    const starsForVote = snap0?.starsAtVotingStart ?? stars;
    const quorumForVote = snap0?.quorumAtVotingStart ?? stageInfo.quorum;
    // Freeze the vote window BEFORE fetching reactions so a failed fetch
    // cannot leave the issue without a deadline (later cycles would then count
    // reactions that arrived after this settle run).
    const voteRecords = voteDeadlineRecords(issue.number);
    const window = pickVoteWindow(voteRecords);
    const existingDeadline = window.endAt;
    const voteDeadlineAt = existingDeadline || new Date().toISOString();
    const voteWindowStartAt = window.startAt;
    if (!existingDeadline) {
      writeDecision(`settle-vote-deadline-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        voteDeadlineAt,
        // Keep a pre-frozen window start (from openVoteWindow). Do not invent
        // one at settle time — that would drop in-window votes already cast.
        ...(voteWindowStartAt ? { voteWindowStartAt } : {}),
        frozenAt: new Date().toISOString(),
      });
    }
    // First complete fetch is frozen so a later deferred retry cannot see
    // deleted reactions or newly-added ones that slipped past the deadline.
    // Keyed by window start so a re-opened vote never reuses the old snapshot.
    // Key reactions snapshots by window start so a re-open never reuses the
    // previous window's freeze. Missing start falls back to a unique suffix.
    const windowKey = (voteWindowStartAt || `open-${Date.now()}`).replace(/[^0-9A-Za-z_-]/g, "");
    const reactionsSnapPath = path.join(
      decisionsDir,
      `settle-reactions-${issue.number}-${windowKey}.json`,
    );
    let rawReactions = null;
    if (fs.existsSync(reactionsSnapPath)) {
      try {
        const snapRec = JSON.parse(fs.readFileSync(reactionsSnapPath, "utf8"));
        // Record is `{ reactions: [...] }` — never treat the envelope as an array.
        rawReactions = extractReactionList(snapRec);
      } catch {
        rawReactions = null;
      }
    }
    if (!rawReactions) {
      rawReactions = await listIssueReactions(issue.number);
      writeDecision(`settle-reactions-${issue.number}-${windowKey}.json`, {
        issueNumber: issue.number,
        reactions: rawReactions,
        capturedAt: new Date().toISOString(),
        voteDeadlineAt,
        voteWindowStartAt: voteWindowStartAt || null,
      });
    }
    // Freeze both inputs durably before account-age lookups can block or time out.
    if (!persistDecisions(`freeze-vote-inputs-${issue.number}`)) {
      log(`  #${issue.number} vote inputs could not be persisted — defer settlement`);
      results.push({
        issueNumber: issue.number,
        outcome: "deferred_vote_freeze_persist_failed",
      });
      continue;
    }
    const reactions = filterReactionsByWindow(rawReactions, {
      startAt: voteWindowStartAt,
      endAt: voteDeadlineAt,
    });
    if (reactions.length !== (rawReactions || []).length) {
      log(
        `  #${issue.number} filtered ${(rawReactions || []).length - reactions.length} reaction(s) outside the vote window`,
      );
    }
      const createdAtByLogin = await resolveCreatedAt(reactions, issue.user?.login);
    // Account-age gate is evaluated at the frozen deadline, not "today", so a
    // deferred retry cannot flip a voter who ages past the threshold mid-window.
    const tallyNow = Date.parse(voteDeadlineAt) || Date.now();
    const tally = tallyVotes(reactions, issue.user?.login, {
      minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
      now: tallyNow,
      getCreatedAt: (login) =>
        createdAtByLogin.get(login) ?? { ok: false, createdAt: null, reason: "lookup_failed" },
    });
    const { founderVote } = applyFounderVote({
      stars: starsForVote,
      reactions,
      founderLogin: FOUNDER_LOGIN,
      ceiling: FOUNDER_STAR_CEILING,
    });
    let outcome = settleOutcome({
      up: tally.up,
      down: tally.down,
      quorum: quorumForVote,
      founderVote,
    });
    log(
      `  #${issue.number} → ${outcome} (👍${tally.up} 👎${tally.down} quorum=${quorumForVote} stars=${starsForVote}${founderVote ? " founderVote" : ""})`,
    );

    // Eligibility lookup incomplete (rate limit / transient API failure) is not
    // a vote against the proposal. Never settle irreversibly this cycle.
    if ((tally.lookupFailed ?? 0) > 0 && !founderVote) {
      log(`  #${issue.number} deferred: ${tally.lookupFailed} account lookup(s) failed`);
      writeDecision(`settle-deferred-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome: "deferred_lookup_incomplete",
        votes: tally,
        lookupFailed: tally.lookupFailed,
        stars: starsForVote,
        quorum: quorumForVote,
        voteDeadlineAt,
        deferredAt: new Date().toISOString(),
      });
      // Push deadline + reaction snapshot so a killed job cannot lose the
      // frozen ticket and re-tally against a mutated reaction set.
      if (!persistDecisions(`settle-defer-${issue.number}`)) {
        log(`  #${issue.number} defer persist failed — will retry next cycle`);
      }
      results.push({
        issueNumber: issue.number,
        outcome: "deferred_lookup_incomplete",
        lookupFailed: tally.lookupFailed,
      });
      continue;
    }

    if (outcome === "ratified") {
      const pType = snap0?.proposalType || parseProposalType(issue.body || "");
      let category = parseCategory(issue.body || "");
      let text = parseRuleText(issue.body || "");
      let targetRuleId = snap0?.targetRuleId || parseTargetRule(issue.body || "");
      let targetGroup = snap0?.targetGroup || parseTargetGroup(issue.body || "");

      // C3: reject if no snapshot — prevents pre-review bypass via manual `voting` label.
      // (Frozen-pass snapshot loss is already recovered above, before tally.)
      if (!snapComplete) {
        guardError = "Missing or incomplete pre-review snapshot";
        outcome = "rejected_by_guard";
      } else {
        // Prefer the pre-review snapshot so post-vote body edits cannot change the rule.
        // Empty live fields count as changes when the snapshot has a value.
        const snap = snap0;
        const liveCategory = parseCategory(issue.body || "") || null;
        const liveText = (parseRuleText(issue.body || "") || "").trim();
        const liveTarget = parseTargetRule(issue.body || "") || null;
        const liveType = parseProposalType(issue.body || "") || null;
        const liveTargetGroup = parseTargetGroup(issue.body || "") || null;
        const liveContract = parseEvidenceContractSection(issue.body || "");
        const snapContract = snap.evidenceContract || {
          requiresEvidence: [],
          evidenceAny: [],
          declared: false,
        };
        const contractChanged =
          normalizeContract(snapContract) !==
          normalizeContract({
            requiresEvidence: liveContract.requiresEvidence,
            evidenceAny: liveContract.evidenceAny,
            declared: !liveContract.empty,
          });
        const snapText = String(snap.ruleText || "").trim();
        const changed =
          (snap.proposalType && liveType !== snap.proposalType) ||
          (snap.category && liveCategory !== snap.category) ||
          (snapText && liveText !== snapText) ||
          (snap.targetRuleId && liveTarget !== snap.targetRuleId) ||
          (snap.targetGroup && liveTargetGroup !== snap.targetGroup) ||
          contractChanged;
        if (changed) {
          guardError = "Issue body changed after pre-review snapshot";
          outcome = "rejected_by_guard";
        } else {
          category = snap.category || category;
          text = snap.ruleText || text;
          targetRuleId = snap.targetRuleId || targetRuleId;
          targetGroup = snap.targetGroup || targetGroup;
        }
      }

      if (outcome === "ratified" && !["new", "amend", "revoke"].includes(pType)) {
        guardError = `Unsupported proposal type (${pType})`;
        outcome = "rejected_by_guard";
      } else if (outcome === "ratified") {
        if (pType === "new") {
          if (!targetGroup || !/^\d+$/.test(targetGroup)) {
            guardError = "Missing or invalid ## Target Group (e.g., 3)";
            outcome = "rejected_by_guard";
          } else {
            const groupDef = findRuleFile(path.join(ROOT, "rules"), `${targetGroup}-0`);
            const groupDisposition = missingTargetDisposition({
              rulesFresh,
              found: Boolean(groupDef),
            });
            if (groupDisposition === "defer") {
              // Stale checkout — neither a miss nor a hit is trustworthy for
              // status/category facts (stale positive would wrongly ratify).
              writeDecision(`settle-deferred-${issue.number}-${Date.now()}.json`, {
                issueNumber: issue.number,
                outcome: "deferred_rules_stale",
                reason: groupDef
                  ? `rules_stale:unverified_group_facts:${targetGroup}`
                  : `target_group_not_on_disk:${targetGroup}`,
                rulesFresh: false,
                deferredAt: new Date().toISOString(),
              });
              results.push({
                issueNumber: issue.number,
                outcome: "deferred_rules_stale",
                targetGroup,
              });
              continue;
            }
            if (!groupDef) {
              guardError = `Target group ${targetGroup} not found on disk (need ${targetGroup}-0)`;
              outcome = "rejected_by_guard";
              } else if (groupDef.type !== "group" || groupDef.status !== "active") {
                guardError = `Target group ${targetGroup} is not active (status ${groupDef.status || "missing"})`;
              outcome = "rejected_by_guard";
            } else if (
              category &&
              groupDef.category &&
              isCategory(category) &&
              category !== groupDef.category
            ) {
              guardError = `Category ${category} does not match group ${targetGroup} (expected ${groupDef.category})`;
              outcome = "rejected_by_guard";
            } else {
              const nextItem = nextFreeItemNumber(
                targetGroup,
                [...usedIds].map((id) => ({ id })),
              );
              const nextId = `${targetGroup}-${nextItem}`;
              const guardMsg = guardRule({
                text,
                category: isCategory(category) ? category : null,
                nextId,
                existingIds: usedIds,
                maxChars: RULE_MAX_CHARS,
              });
              if (guardMsg) {
                guardError = guardMsg;
                outcome = "rejected_by_guard";
              } else {
                const filePath = ruleFileName(nextId);
                const frozenContract = contractForRuleBuild(snap0?.evidenceContract);
                const content = buildRuleFile({
                  id: nextId,
                  type: "item",
                  group: targetGroup,
                  category,
                  text,
                  status: "active",
                  source: "community",
                  requiresEvidence: frozenContract.requiresEvidence,
                  evidenceAny: frozenContract.evidenceAny,
                });
                const branch = `rule/${nextId}-from-${issue.number}`;
                const prRequest = {
                  owner,
                  repo,
                  branch,
                  base: "main",
                  path: filePath,
                  content,
                  title: `Rule ${nextId}: ${category} (issue #${issue.number})`,
                  body: `Ratified community proposal #${issue.number}.\n\n**type:** new\n**targetGroup:** ${targetGroup}\n**quorum:** ${quorumForVote} (starsAtVotingStart=${starsForVote}, stage=${stageInfo.stage})\n**votes:** 👍${tally.up} 👎${tally.down}\n**voteDeadline:** settle run\n**founderVote:** ${founderVote}${founderVote ? ` (F1 casting vote, starsAtVotingStart < ${FOUNDER_STAR_CEILING})` : ""}`,
                };
                // Freeze the vote result BEFORE any PR/merge side effect so a
                // crash in upsertFilePr/finishPr cannot leave the issue to be
                // re-tallied. prRequest lets a later cycle retry PR creation
                // when upsertFilePr failed (prNumber stays null).
                // Occupy nextId NOW — a later proposal in this cycle must not
                // allocate the same number even if upsertFilePr fails below.
                usedIds.add(nextId);
                writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  outcome: "ratified_pending_merge",
                  voteOutcome: "ratified",
                  votes: tally,
                  stars: starsForVote,
                  starsAtVotingStart: starsForVote,
                  liveStars: stars,
                  stage: stageInfo.stage,
                  quorum: quorumForVote,
                  quorumAtVotingStart: quorumForVote,
                  voteDeadline: "settle",
                  voteDeadlineAt,
                  minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
                  founderVote,
                  founderLogin: founderVote ? FOUNDER_LOGIN : null,
                  prNumber: null,
                  prPending: true,
                  prRequest,
                  prType: "new",
                  prBranch: branch,
                  prBaseOwner: owner,
                  prBaseRepo: repo,
                  prBaseRef: "main",
                  nextId,
                  skippedMerge: true,
                  evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
                  settledAt: new Date().toISOString(),
                });
                if (!persistDecisions(`create-pr-${issue.number}`)) {
                  writeDecision(`settle-pr-error-${issue.number}-${Date.now()}.json`, {
                    issueNumber: issue.number,
                    error: "decision_persist_failed_before_pr_create",
                    at: new Date().toISOString(),
                  });
                  results.push({
                    issueNumber: issue.number,
                    outcome: "ratified_pending_merge",
                    reason: "decision_persist_failed",
                  });
                  continue;
                }
                const pr = await upsertFilePr(prRequest);
                prNumber = pr.number;
                prUrl = pr.html_url;
                usedIds.add(nextId);
                // Persist PR identity before finishPr so a crash cannot reopen #2.
                writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  outcome: "ratified_pending_merge",
                  voteOutcome: "ratified",
                  votes: tally,
                  stars: starsForVote,
                  starsAtVotingStart: starsForVote,
                  liveStars: stars,
                  stage: stageInfo.stage,
                  quorum: quorumForVote,
                  quorumAtVotingStart: quorumForVote,
                  voteDeadline: "settle",
                  voteDeadlineAt,
                  minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
                  founderVote,
                  founderLogin: founderVote ? FOUNDER_LOGIN : null,
                  prNumber: pr.number,
                  prHeadSha: pr.head?.sha || null,
                  prBranch: branch,
                  prBaseOwner: owner,
                  prBaseRepo: repo,
                  prBaseRef: "main",
                  prPending: false,
                  prRequest: null,
                  prType: "new",
                  nextId,
                  skippedMerge: true,
                  evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
                  settledAt: new Date().toISOString(),
                });
                // Preserve pre-review snapshot; write settlement info separately
                writeDecision(`settlement-snapshot-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  category,
                  ruleText: text,
                  proposalType: "new",
                  ruleId: nextId,
                  targetGroup,
                  prNumber: pr.number,
                  prHeadSha: pr.head?.sha || null,
                  branch,
                  baseOwner: owner,
                  baseRepo: repo,
                  baseRef: "main",
                  snapshotAt: new Date().toISOString(),
                });
                // finishPr may throw (e.g. getPull); the vote is already frozen
                // above. Record the PR and fall through to the full settlement.
                try {
                  await finishPr({ issue, prNumber, nextId, type: "new" });
                } catch (err) {
                  skippedMerge = true;
                  log(`settle #${issue.number} finishPr failed (vote frozen):`, String(err.message || err));
                  writeDecision(`settle-pr-error-${issue.number}-${Date.now()}.json`, {
                    issueNumber: issue.number,
                    prNumber,
                    nextId,
                    error: String(err.message || err).slice(0, 300),
                    at: new Date().toISOString(),
                  });
                }
              }
            }
          }
        } else {
          // amend | revoke — same x-y file path on disk; preserve metadata
          if (!targetRuleId || !/^\d+-\d+$/.test(targetRuleId)) {
            guardError = "Missing or invalid ## Target Rule (e.g., 3-1)";
            outcome = "rejected_by_guard";
          } else {
            const existing = findRuleFile(path.join(ROOT, "rules"), targetRuleId);
              const parentGroup =
                existing && existing.type !== "group"
                  ? findRuleFile(
                      path.join(ROOT, "rules"),
                      `${String(existing.group || targetRuleId.split("-")[0]).replace(/-0$/, "")}-0`,
                    )
                  : null;
            const ruleDisposition = missingTargetDisposition({
              rulesFresh,
              found: Boolean(existing),
            });
            if (ruleDisposition === "defer") {
              writeDecision(`settle-deferred-${issue.number}-${Date.now()}.json`, {
                issueNumber: issue.number,
                outcome: "deferred_rules_stale",
                reason: existing
                  ? `rules_stale:unverified_rule_facts:${targetRuleId}`
                  : `target_rule_not_on_disk:${targetRuleId}`,
                rulesFresh: false,
                deferredAt: new Date().toISOString(),
              });
              results.push({
                issueNumber: issue.number,
                outcome: "deferred_rules_stale",
                targetRuleId,
              });
              continue;
            }
            if (!existing) {
              guardError = `Target rule ${targetRuleId} not found on disk`;
              outcome = "rejected_by_guard";
              } else if (existing.status !== "active") {
                guardError = `Target rule ${targetRuleId} is not active (status ${existing.status || "missing"})`;
                outcome = "rejected_by_guard";
              } else if (
                existing.type !== "group" &&
                (!parentGroup || parentGroup.type !== "group" || parentGroup.status !== "active")
              ) {
                guardError = `Parent group for target rule ${targetRuleId} is not active`;
              outcome = "rejected_by_guard";
            } else {
              const ruleCategory =
                pType === "revoke"
                  ? existing.category
                  : isCategory(category)
                    ? category
                    : existing.category;
              const maxChars = isGroupRule(targetRuleId) ? RULE_MAX_CHARS_GROUP : RULE_MAX_CHARS;
              // Same length contract as evaluateProposalBody (trim + min 20 for
              // every type, including revoke justification).
              const textLen = String(text || "").trim().length;
              if (pType === "amend") {
                if (!text || textLen < 20 || textLen > maxChars) {
                  guardError = "Amend rule text length invalid";
                  outcome = "rejected_by_guard";
                } else if (!isCategory(ruleCategory)) {
                  guardError = "Invalid category";
                  outcome = "rejected_by_guard";
                } else if (scanRuleText(text)) {
                  guardError = `Rule text rejected (${scanRuleText(text)})`;
                  outcome = "rejected_by_guard";
                }
              } else {
                // revoke: Rule Text is the public justification (body keeps the original rule text)
                if (!text || textLen < 20 || textLen > maxChars) {
                  guardError = "Revoke justification length invalid";
                  outcome = "rejected_by_guard";
                } else if (scanRuleText(text)) {
                  guardError = "Revoke justification failed safety scan";
                  outcome = "rejected_by_guard";
                }
              }

              if (outcome === "ratified") {
                // Freeze the date used in rule frontmatter to the vote deadline
                // (or this instant) so a next-day retry cannot rebuild a different
                // blob than the one already on the PR branch.
                const today = (voteDeadlineAt || new Date().toISOString()).slice(0, 10);
                const inherited = evidenceMetaFromRuleFile(existing);
                const declaredContract =
                  snap0?.evidenceContract && snap0.evidenceContract.declared
                    ? snap0.evidenceContract
                    : null;
                const requiresEvidence = declaredContract
                  ? declaredContract.requiresEvidence || []
                  : inherited.requiresEvidence;
                const evidenceAny = declaredContract
                  ? declaredContract.evidenceAny || []
                  : inherited.evidenceAny;
                const preserve = {
                  id: targetRuleId,
                  type: existing.type,
                  group: existing.group || targetRuleId.split("-")[0],
                  category: ruleCategory,
                  name: existing.data?.name || null,
                  source: existing.data?.source || "community",
                  version: (Number(existing.data?.version) || 1) + 1,
                  amendedAt: today,
                  effectiveAt: existing.data?.effective_at || null,
                  requiresEvidence,
                  evidenceAny,
                };
                const content =
                  pType === "amend"
                    ? buildRuleFile({
                        ...preserve,
                        text,
                        status: "active",
                      })
                    : buildRuleFile({
                        ...preserve,
                        text: existing.body,
                        status: "revoked",
                        source: existing.data?.source || "community",
                        revokedAt: today,
                        revokedReason: text,
                      });
                const branch = `rule/${targetRuleId}-from-${issue.number}`;
                const prRequest = {
                  owner,
                  repo,
                  branch,
                  base: "main",
                  path: existing.path,
                  content,
                  title: `Rule ${targetRuleId}: ${pType} (issue #${issue.number})`,
                  body: `Ratified community proposal #${issue.number}.\n\n**type:** ${pType}\n**target:** ${targetRuleId}\n**quorum:** ${quorumForVote} (starsAtVotingStart=${starsForVote}, stage=${stageInfo.stage})\n**votes:** 👍${tally.up} 👎${tally.down}\n**voteDeadline:** settle run\n**founderVote:** ${founderVote}${founderVote ? ` (F1 casting vote, starsAtVotingStart < ${FOUNDER_STAR_CEILING})` : ""}`,
                };
                // Freeze vote result before PR/merge side effects (same as `new`).
                writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  outcome: "ratified_pending_merge",
                  voteOutcome: "ratified",
                  votes: tally,
                  stars: starsForVote,
                  starsAtVotingStart: starsForVote,
                  liveStars: stars,
                  stage: stageInfo.stage,
                  quorum: quorumForVote,
                  quorumAtVotingStart: quorumForVote,
                  voteDeadline: "settle",
                  voteDeadlineAt,
                  minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
                  founderVote,
                  founderLogin: founderVote ? FOUNDER_LOGIN : null,
                  prNumber: null,
                  prPending: true,
                  prRequest,
                  prType: pType,
                  prBranch: branch,
                  prBaseOwner: owner,
                  prBaseRepo: repo,
                  prBaseRef: "main",
                  nextId: targetRuleId,
                  skippedMerge: true,
                  evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
                  settledAt: new Date().toISOString(),
                });
                if (!persistDecisions(`create-pr-${issue.number}`)) {
                  writeDecision(`settle-pr-error-${issue.number}-${Date.now()}.json`, {
                    issueNumber: issue.number,
                    error: "decision_persist_failed_before_pr_create",
                    at: new Date().toISOString(),
                  });
                  results.push({
                    issueNumber: issue.number,
                    outcome: "ratified_pending_merge",
                    reason: "decision_persist_failed",
                  });
                  continue;
                }
                const pr = await upsertFilePr(prRequest);
                prNumber = pr.number;
                prUrl = pr.html_url;
                // Persist PR identity before finishPr so a crash cannot reopen #2.
                writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  outcome: "ratified_pending_merge",
                  voteOutcome: "ratified",
                  votes: tally,
                  stars: starsForVote,
                  starsAtVotingStart: starsForVote,
                  liveStars: stars,
                  stage: stageInfo.stage,
                  quorum: quorumForVote,
                  quorumAtVotingStart: quorumForVote,
                  voteDeadline: "settle",
                  voteDeadlineAt,
                  minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
                  founderVote,
                  founderLogin: founderVote ? FOUNDER_LOGIN : null,
                  prNumber: pr.number,
                  prHeadSha: pr.head?.sha || null,
                  prBranch: branch,
                  prBaseOwner: owner,
                  prBaseRepo: repo,
                  prBaseRef: "main",
                  prPending: false,
                  prRequest: null,
                  prType: pType,
                  nextId: targetRuleId,
                  skippedMerge: true,
                  evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
                  settledAt: new Date().toISOString(),
                });
                // Preserve pre-review snapshot; write settlement info separately
                writeDecision(`settlement-snapshot-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  category: ruleCategory,
                  ruleText: text,
                  proposalType: pType,
                  targetRuleId,
                  prNumber: pr.number,
                  prHeadSha: pr.head?.sha || null,
                  branch,
                  baseOwner: owner,
                  baseRepo: repo,
                  baseRef: "main",
                  snapshotAt: new Date().toISOString(),
                });
                try {
                  await finishPr({
                    issue,
                    prNumber,
                    nextId: targetRuleId,
                    type: pType,
                  });
                } catch (err) {
                  skippedMerge = true;
                  log(`settle #${issue.number} finishPr failed (vote frozen):`, String(err.message || err));
                  writeDecision(`settle-pr-error-${issue.number}-${Date.now()}.json`, {
                    issueNumber: issue.number,
                    prNumber,
                    nextId: targetRuleId,
                    error: String(err.message || err).slice(0, 300),
                    at: new Date().toISOString(),
                  });
                }
              }
            }
          }
        }
      }
    }

    async function finishPr({ issue, prNumber, nextId, type }) {
      // Comments here are best-effort audit only — they must never flip merge state
      // or abort settlement after the PR exists.
        const say = async (kind, text) => {
        try {
            await commentOnce(
              issue.number,
              `<!-- aicanonfeed-pr-status:${issue.number}:${prNumber}:${kind} -->`,
              text,
            );
        } catch (err) {
          log(`finishPr #${issue.number} comment failed (non-fatal):`, String(err.message || err));
        }
      };
      let labels = [];
      let headSha = null;
      try {
        const prFull = await getPull(prNumber);
        labels = (prFull.labels || []).map((l) => l.name);
        headSha = prFull.head?.sha || null;
        if (!prMatchesSettlementIdentity(prFull, issue.number, prNumber)) {
          skippedMerge = true;
            await say(
              "identity-mismatch",
            `PR #${prNumber} does not match the frozen head/base repository and branch identity. A maintainer must inspect it; it will not be auto-merged.`,
          );
          return;
        }
      } catch {
        // Cannot confirm kill-switch labels → do not auto-merge this cycle.
        skippedMerge = true;
          await say(
            "labels-unreadable",
          `PR #${prNumber} opened but labels were unreadable — **not auto-merged**. A maintainer must merge to apply ${type} ${nextId}.`,
        );
        return;
      }
      // If the freeze recorded a head SHA, refuse to merge anything else.
      const frozenSha = settlementPrHeadSha(issue.number);
      if (!prHeadMatchesFrozen({ head: { sha: headSha } }, frozenSha)) {
        skippedMerge = true;
          await say(
            "head-mismatch",
          `PR #${prNumber} cannot be auto-merged because its head (\`${headSha || "unknown"}\`) does not match the frozen content identity (\`${frozenSha || "unknown"}\`). A maintainer must inspect it.`,
        );
        return;
      }
      if (!canAutoMerge(stars)) {
        skippedMerge = true;
          await say(
            "star-gate",
          `stars ${stars} < ${AUTO_MERGE_MIN_STARS}: PR #${prNumber} opened but **not auto-merged**. A maintainer must merge to apply ${type} ${nextId}.`,
        );
      } else if (labels.includes(LABELS.doNotMerge)) {
        skippedMerge = true;
          await say(
            "kill-switch",
          `Maintainer kill switch: PR #${prNumber} has \`do-not-merge\`. Not auto-merging.`,
        );
      } else {
        // Confirm both the merge response and that its commit reached the
        // frozen base before recording a ratified outcome.
        let merged = false;
        let mergedIntegrityMismatch = false;
        let mergeErr = null;
        try {
          if (!persistDecisions(`merge-pr-${prNumber}`)) {
            throw new Error("decision persistence failed — not merging");
          }
          const mergeResult = await mergePullRequest(prNumber, {
            expectedSha: headSha || frozenSha || null,
          });
          if (mergeResult?.merged !== true || !mergeResult.sha) {
            throw new Error("merge result was not confirmed");
          }
          const baseRef = settlementPrIdentity(issue.number).baseRef;
          if (await isCommitReachableFromRef(mergeResult.sha, baseRef)) {
            merged = true;
          } else {
            mergedIntegrityMismatch = true;
            skippedMerge = true;
            await markPrIntegrityNeedsManual({
              issueNumber: issue.number,
              prNumber,
              frozenSha,
              currentSha: headSha,
              reason: "merged_outside_frozen_base",
            });
          }
        } catch (err) {
          mergeErr = err;
          // Confirm via API — merge may have landed despite a transport error.
          try {
            const full = await getPull(prNumber);
            const confirmed = await pullIsMerged(full);
            const confirmedHeadSha = full.head?.sha || null;
            const identityMatches = prMatchesSettlementIdentity(full, issue.number, prNumber);
            const headMatches = prHeadMatchesFrozen(full, frozenSha);
            const targetMatches = confirmed === true
              ? await isCommitReachableFromRef(
                  full.merge_commit_sha,
                  settlementPrIdentity(issue.number).baseRef,
                )
              : false;
            if (
              confirmed === true &&
              identityMatches &&
              headMatches &&
              targetMatches
            ) merged = true;
            else if (confirmed === true) {
              merged = false;
              mergedIntegrityMismatch = true;
              skippedMerge = true;
              await markPrIntegrityNeedsManual({
                issueNumber: issue.number,
                prNumber,
                frozenSha,
                currentSha: confirmedHeadSha,
                reason: !identityMatches
                  ? "merge_state_confirmed_with_different_identity"
                  : !headMatches
                    ? "merge_state_confirmed_with_different_head"
                    : "merged_outside_frozen_base",
              });
            } else if (confirmed === false) merged = false;
            else {
              // Unknown — do not claim merged, but also do not record a hard
              // merge failure. Leave pending for a later recover cycle.
              merged = false;
              mergeErr = new Error("merge state unconfirmed");
            }
          } catch {
            merged = false;
            mergeErr = new Error("merge state unconfirmed");
          }
        }
        if (merged) {
          await say("merged", `Merged PR #${prNumber} — ${type} ${nextId} applied.`);
          const synced = syncWithOrigin();
          rulesFresh = Boolean(synced.ok);
          if (!rulesFresh) {
            log(
              `settle #${issue.number} merged PR #${prNumber}, but local rules could not be refreshed:`,
              synced.error || "unknown sync error",
            );
          }
        } else if (mergedIntegrityMismatch) {
          skippedMerge = true;
        } else {
          skippedMerge = true;
            await say(
              "merge-failed",
            `PR #${prNumber} opened but merge failed: ${String(mergeErr?.message || mergeErr || "not merged").slice(0, 200)}`,
          );
        }
      }
    }

    // Ratified only when the rule file is actually on main. Pending merge stays open.
    if (outcome === "ratified" && skippedMerge) {
      outcome = "ratified_pending_merge";
    }

    const label = labelForOutcome(outcome);

    // Persist settlement record BEFORE external side effects.
    const settledAt = new Date().toISOString();
    // Carry PR routing identity from the frozen mid-run records so a later
    // recover never depends on settlement-snapshot surviving alone.
    const frozen = latestSettlement(issue.number) || prior || {};
    const snapRec = latestSettlementSnapshot(issue.number) || {};
    writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
      issueNumber: issue.number,
      outcome,
      votes: tally,
      stars: starsForVote,
      starsAtVotingStart: starsForVote,
      liveStars: stars,
      stage: stageInfo.stage,
      quorum: quorumForVote,
      quorumAtVotingStart: quorumForVote,
      voteDeadline: "settle",
      voteDeadlineAt,
      minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
      founderVote,
      founderLogin: founderVote ? FOUNDER_LOGIN : null,
      prNumber,
      prPending: false,
      prRequest: prNumber ? null : undefined,
      // Public tally result — independent of later guard/PR outcomes.
      voteOutcome:
        frozen.voteOutcome ??
        prior?.voteOutcome ??
        settleOutcome({
          up: tally.up,
          down: tally.down,
          quorum: quorumForVote,
          founderVote,
        }),
      nextId: frozen.nextId ?? snapRec.ruleId ?? snapRec.targetRuleId ?? null,
      prType: frozen.prType ?? null,
      prHeadSha: frozen.prHeadSha ?? snapRec.prHeadSha ?? null,
      prBranch:
        frozen.prBranch ?? frozen.prRequest?.branch ?? snapRec.branch ?? null,
      prBaseOwner: frozen.prBaseOwner ?? frozen.prRequest?.owner ?? snapRec.baseOwner ?? owner,
      prBaseRepo: frozen.prBaseRepo ?? frozen.prRequest?.repo ?? snapRec.baseRepo ?? repo,
      prBaseRef: frozen.prBaseRef ?? frozen.prRequest?.base ?? snapRec.baseRef ?? "main",
      guardError,
      skippedMerge,
      evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
      settledAt,
    });

    // Terminal without a PR still mutates GitHub labels/close — persist first.
    if (!persistDecisions(`settle-terminal-${issue.number}`)) {
      writeDecision(`settle-pr-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome,
        error: "decision_persist_failed_before_terminal_side_effects",
        at: new Date().toISOString(),
      });
      results.push({
        issueNumber: issue.number,
        outcome,
        reason: "decision_persist_failed",
      });
      continue;
    }

    let labelsOk = true;
    try {
      await setLabels(issue.number, [label], [LABELS.voting, LABELS.proposal]);
    } catch (err) {
      labelsOk = false;
      log(`settle #${issue.number} label failed (record already written):`, String(err.message || err));
      writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome,
        error: String(err.message || err).slice(0, 300),
        at: new Date().toISOString(),
      });
    }
    // Labels must land before close: a closed issue leaves the `voting` queue and
    // cannot be resumed from the frozen settlement next cycle.
    if (!labelsOk) {
      results.push({
        issueNumber: issue.number,
        outcome,
        prNumber,
        founderVote,
        labelsOk: false,
        deferredClose: true,
      });
      continue;
    }

    const summary = [
      `### Settlement — ${outcome}`,
      "",
      `- 👍 ${tally.up} / 👎 ${tally.down} (void ${tally.voided}, valid ${tally.valid})`,
      `- quorum (approve-count): ${quorumForVote} · starsAtVotingStart ${starsForVote} · stage ${stageInfo.stage}`,
      `- vote deadline: this settle run (reactions after are not counted)`,
      `- account age gate: ≥ ${MIN_ACCOUNT_AGE_DAYS} days · dropped young ${tally.droppedYoung ?? 0} · dropped unknown/not-found ${tally.droppedUnknown ?? 0}`,
      founderVote
        ? `- **founder casting vote (F1):** yes — \`${FOUNDER_LOGIN}\` 👍 while stars < ${FOUNDER_STAR_CEILING}`
        : "",
      prUrl ? `- PR: ${prUrl}` : "",
      guardError ? `- guard: ${guardError}` : "",
      outcome === "ratified_pending_merge"
        ? "- rule is **not active** until the PR is merged"
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    // Comment and close are separate: a failed comment must not skip close
    // forever: leave the issue open so terminal reconciliation can retry it.
    let commentDelivered = false;
    try {
      await deliverSettlementComment(
        issue.number,
        { outcome, voteOutcome: frozen.voteOutcome ?? prior?.voteOutcome ?? null, settledAt, voteDeadlineAt, prNumber },
        summary,
        "settle",
      );
      commentDelivered = true;
    } catch (err) {
      log(`settle #${issue.number} comment failed (record already written):`, String(err.message || err));
      writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome,
        label,
        phase: "comment",
        error: String(err.message || err).slice(0, 300),
        at: new Date().toISOString(),
      });
    }
    if (outcome !== "ratified_pending_merge" && commentDelivered) {
      try {
        await closeIssue(issue.number);
      } catch (err) {
        log(`settle #${issue.number} close failed (record already written):`, String(err.message || err));
        writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome,
          label,
          phase: "close",
          error: String(err.message || err).slice(0, 300),
          at: new Date().toISOString(),
        });
      }
    } else if (outcome !== "ratified_pending_merge") {
      log(`settle #${issue.number} remains open until its settlement comment is delivered`);
    }

    results.push({
      issueNumber: issue.number,
      outcome,
      prNumber,
      founderVote,
    });
    } catch (err) {
      log(`settle #${issue.number} crashed (continuing):`, String(err.message || err));
      writeDecision(`settle-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        error: String(err.message || err).slice(0, 400),
        at: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, outcome: "settle_error" });
    }
  }
  return results;
}

/**
 * Reconcile issues stuck in ratified_pending_merge:
 * - open PR still waiting → (non-S0) try merge; else leave untouched
 * - PR already merged → ratified + close
 * - PR closed without merge → rejected + close
 * Never throws — a listing/API failure must not abort the whole governance cycle.
 */
async function recoverPendingPhase({ stars }) {
  const results = [];
  let pending;
  try {
    pending = await listOpenIssuesWithLabel(LABELS.pendingMerge);
  } catch (err) {
    log("recover-pending: list issues failed:", String(err.message || err));
    return results;
  }
  if (!pending.length) {
    log("recover-pending: none");
    return results;
  }
  log(`recover-pending: ${pending.length} issue(s)`);

  let openPulls = [];
  let closedPulls = [];
  try {
    openPulls = await listPulls({ state: "open" });
    closedPulls = await listPulls({ state: "closed" });
  } catch (err) {
    log("recover-pending: listPulls failed:", String(err.message || err));
    // Still try per-issue getPull fallback below via settlement prNumber when possible.
  }

  for (const issue of pending) {
    try {
      // A label alone is not authority to merge — require a frozen settlement
      // that actually ratified (or froze as pending-merge).
      const frozenSettle = latestSettlement(issue.number);
      const frozenOk =
        frozenSettle &&
        (frozenSettle.outcome === "ratified" ||
          frozenSettle.outcome === "ratified_pending_merge" ||
          // Abandoned-after-ratify is terminal but may still need label/close repair.
          frozenSettle.outcome === "ratified_pr_abandoned");
      if (!frozenOk) {
        results.push({
          issueNumber: issue.number,
          outcome: "skipped_no_frozen_settlement",
        });
        continue;
      }
      // Prefer the PR number frozen in settlement records. Branch-name matching
      // alone can pick a same-named fork PR or the wrong open sibling.
      const frozenPrNumber = settlementPrNumber(issue.number);
      let openPr = null;
      let closedPr = null;
      if (frozenPrNumber) {
        try {
          const pr = await getPull(frozenPrNumber);
          if (!prMatchesSettlementIdentity(pr, issue.number, frozenPrNumber)) {
            results.push({
              issueNumber: issue.number,
              outcome: "skipped_pr_identity_mismatch",
              prNumber: frozenPrNumber,
            });
            continue;
          }
          if (pr.state === "open") openPr = pr;
          else closedPr = pr;
        } catch {
          /* fall through to branch match */
        }
      }
      if (!openPr && !closedPr) {
        const branchRe = new RegExp(`rule/\\d+-\\d+-from-${issue.number}$`, "i");
        const byBranch = [
          ...openPulls.filter((p) => branchRe.test(p.head?.ref || "")),
          ...closedPulls.filter((p) => branchRe.test(p.head?.ref || "")),
        ].filter((p) =>
          prMatchesSettlementIdentity(p, issue.number, frozenPrNumber || null),
        );
        openPr = byBranch.find((p) => p.state === "open") || null;
        closedPr = byBranch.find((p) => p.state !== "open") || null;
      }

      if (openPr) {
        if (!canAutoMerge(stars)) {
          results.push({ issueNumber: issue.number, outcome: "still_pending", prNumber: openPr.number });
          continue;
        }
        let labels = null;
        let identityMismatch = false;
        try {
          const prFull = await getPull(openPr.number);
          if (!prMatchesSettlementIdentity(prFull, issue.number, openPr.number)) {
            identityMismatch = true;
          } else {
            openPr = prFull;
            labels = (prFull.labels || []).map((l) => l.name);
          }
        } catch {
          labels = null;
        }
        if (identityMismatch) {
          results.push({
            issueNumber: issue.number,
            outcome: "skipped_pr_identity_mismatch",
            prNumber: openPr.number,
          });
          continue;
        }
        // Fail-closed: cannot confirm labels → do not merge this cycle.
        if (labels === null) {
          results.push({
            issueNumber: issue.number,
            outcome: "still_pending",
            prNumber: openPr.number,
            reason: "pr_labels_unreadable",
          });
          continue;
        }
        if (labels.includes(LABELS.doNotMerge)) {
          results.push({ issueNumber: issue.number, outcome: "still_pending_killswitch", prNumber: openPr.number });
          continue;
        }
        // Content guard: head must still be the frozen SHA (or we refuse to merge).
        const frozenSha = frozenSettle.prHeadSha || settlementPrHeadSha(issue.number);
        const currentSha = openPr.head?.sha || null;
        if (!prHeadMatchesFrozen(openPr, frozenSha)) {
          results.push({
            issueNumber: issue.number,
            outcome: "skipped_pr_head_changed",
            prNumber: openPr.number,
            frozenSha,
            currentSha,
          });
          await markPrIntegrityNeedsManual({
            issueNumber: issue.number,
            prNumber: openPr.number,
            frozenSha,
            currentSha,
            reason: frozenSha && currentSha
              ? "open_pr_head_changed"
              : "frozen_head_sha_unavailable",
          });
          continue;
        }
        // Even without a frozen SHA, pin the merge to the SHA we are looking at
        // so a mid-merge push cannot slip in unreviewed commits.
        const mergeSha = currentSha || frozenSha || null;
        try {
          if (!persistDecisions(`recover-merge-pr-${openPr.number}`)) {
            results.push({
              issueNumber: issue.number,
              outcome: "still_pending",
              prNumber: openPr.number,
              reason: "decision_persist_failed",
            });
            continue;
          }
          const mergeResult = await mergePullRequest(openPr.number, {
            expectedSha: mergeSha,
          });
          if (mergeResult?.merged !== true || !mergeResult.sha) {
            throw new Error("merge result was not confirmed");
          }
          const frozenBaseRef = settlementPrIdentity(issue.number).baseRef;
          if (!(await isCommitReachableFromRef(mergeResult.sha, frozenBaseRef))) {
            await markPrIntegrityNeedsManual({
              issueNumber: issue.number,
              prNumber: openPr.number,
              frozenSha,
              currentSha,
              reason: "merged_outside_frozen_base",
            });
            results.push({
              issueNumber: issue.number,
              outcome: "skipped_merge_outside_frozen_base",
              prNumber: openPr.number,
              frozenBaseRef,
            });
            continue;
          }
          writeDecision(`recover-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "ratified",
            prNumber: openPr.number,
            recoveredAt: new Date().toISOString(),
          });
          // Authoritative settlement so later reconcile does not reuse
          // a stale `ratified_pending_merge` record. Vote fields are inherited
          // from the frozen settlement so the audit trail keeps the tally.
          writeDecision(
            `settlement-${issue.number}-${Date.now()}.json`,
            inheritVoteFields(issue.number, {
              outcome: "ratified",
              prNumber: openPr.number,
              prHeadSha: currentSha,
              prPending: false,
              skippedMerge: false,
              recoveredAt: new Date().toISOString(),
              settledAt: new Date().toISOString(),
            }),
          );
          if (!persistDecisions(`recover-settlement-${issue.number}`)) {
            results.push({
              issueNumber: issue.number,
              outcome: "ratified",
              prNumber: openPr.number,
              reason: "settlement_persist_failed",
            });
            continue;
          }
          const fx = await applySettlementSideEffects({
            issue,
            label: LABELS.ratified,
            removeLabels: [LABELS.pendingMerge],
            commentText: `✅ PR #${openPr.number} merged on a later cycle — rule is now active. Closing.`,
            shouldClose: true,
            outcome: "ratified",
            via: "recover",
          });
          results.push({
            issueNumber: issue.number,
            outcome: fx.labelsOk ? "ratified" : "ratified_labels_failed",
            prNumber: openPr.number,
          });
        } catch (err) {
          results.push({
            issueNumber: issue.number,
            outcome: "still_pending",
            prNumber: openPr.number,
            error: String(err.message).slice(0, 200),
          });
        }
        continue;
      }

      if (closedPr) {
        let closedFull;
        try {
          closedFull = await getPull(closedPr.number);
        } catch {
          results.push({
            issueNumber: issue.number,
            outcome: "still_pending",
            prNumber: closedPr.number,
            reason: "pr_identity_unreadable",
          });
          continue;
        }
        if (!prMatchesSettlementIdentity(closedFull, issue.number, closedPr.number)) {
          results.push({
            issueNumber: issue.number,
            outcome: "skipped_pr_identity_mismatch",
            prNumber: closedPr.number,
          });
          continue;
        }
        // Merge state must be confirmed before rejecting. Unknown → defer.
        const closedMerged = await pullIsMerged(closedFull);
        if (closedMerged === null) {
          results.push({
            issueNumber: issue.number,
            outcome: "still_pending",
            prNumber: closedPr.number,
            reason: "merge_state_unconfirmed",
          });
          log(`  #${issue.number} closed PR #${closedPr.number} merge state unconfirmed — defer`);
          continue;
        }
        if (closedMerged) {
          const frozenSha = frozenSettle.prHeadSha || settlementPrHeadSha(issue.number);
          const currentSha = closedFull.head?.sha || null;
          if (!prHeadMatchesFrozen(closedFull, frozenSha)) {
            await markPrIntegrityNeedsManual({
              issueNumber: issue.number,
              prNumber: closedPr.number,
              frozenSha,
              currentSha,
              reason: frozenSha && currentSha
                ? "merged_with_changed_head"
                : "merged_head_identity_unavailable",
            });
            results.push({
              issueNumber: issue.number,
              outcome: "skipped_pr_head_changed",
              prNumber: closedPr.number,
              frozenSha,
              currentSha,
              reason: frozenSha && currentSha
                ? "merged_with_changed_head"
                : "merged_head_identity_unavailable",
            });
            log(`  #${issue.number} closed PR #${closedPr.number} was merged but head SHA changed — manual intervention required`);
            continue;
          }
          const frozenBaseRef = settlementPrIdentity(issue.number).baseRef;
          let mergedCommitOnFrozenBase = false;
          try {
            mergedCommitOnFrozenBase = await isCommitReachableFromRef(
              closedFull.merge_commit_sha,
              frozenBaseRef,
            );
          } catch (err) {
            results.push({
              issueNumber: issue.number,
              outcome: "still_pending",
              prNumber: closedPr.number,
              reason: "merge_target_unconfirmed",
              error: String(err.message || err).slice(0, 200),
            });
            continue;
          }
          if (!mergedCommitOnFrozenBase) {
            await markPrIntegrityNeedsManual({
              issueNumber: issue.number,
              prNumber: closedPr.number,
              frozenSha,
              currentSha,
              reason: "merged_outside_frozen_base",
            });
            results.push({
              issueNumber: issue.number,
              outcome: "skipped_merge_outside_frozen_base",
              prNumber: closedPr.number,
              frozenBaseRef,
            });
            continue;
          }

          writeDecision(`recover-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "ratified",
            prNumber: closedPr.number,
            recoveredAt: new Date().toISOString(),
          });
          writeDecision(
            `settlement-${issue.number}-${Date.now()}.json`,
            inheritVoteFields(issue.number, {
              outcome: "ratified",
              prNumber: closedPr.number,
              prHeadSha: currentSha,
              prPending: false,
              skippedMerge: false,
              recoveredAt: new Date().toISOString(),
              settledAt: new Date().toISOString(),
            }),
          );
          if (!persistDecisions(`recover-settlement-${issue.number}`)) {
            results.push({
              issueNumber: issue.number,
              outcome: "ratified",
              prNumber: closedPr.number,
              reason: "settlement_persist_failed",
            });
            continue;
          }
          const fx = await applySettlementSideEffects({
            issue,
            label: LABELS.ratified,
            removeLabels: [LABELS.pendingMerge],
            commentText: `✅ PR #${closedPr.number} was merged outside the bot. Rule is active. Closing.`,
            shouldClose: true,
            outcome: "ratified",
            via: "recover",
          });
          results.push({
            issueNumber: issue.number,
            outcome: fx.labelsOk ? "ratified" : "ratified_labels_failed",
            prNumber: closedPr.number,
          });
          continue;
        }

        // Confirmed closed without merge → vote stands, rule is not active.
        // Never collapse a ratified vote into a generic community "rejected".
        const priorVoteOutcome = frozenSettle?.voteOutcome || frozenSettle?.outcome || null;
        const abandonedFromRatify = priorVoteOutcome === "ratified" || priorVoteOutcome === "ratified_pending_merge";
        const abandonedOutcome = abandonedFromRatify ? "ratified_pr_abandoned" : "rejected_pr_closed";
        writeDecision(`recover-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome: abandonedOutcome,
          voteOutcome: priorVoteOutcome,
          prNumber: closedPr.number,
          recoveredAt: new Date().toISOString(),
        });
        writeDecision(
          `settlement-${issue.number}-${Date.now()}.json`,
          inheritVoteFields(issue.number, {
            outcome: abandonedOutcome,
            voteOutcome: priorVoteOutcome,
            prNumber: closedPr.number,
            prHeadSha: closedPr.head?.sha || null,
            prPending: false,
            skippedMerge: true,
            recoveredAt: new Date().toISOString(),
            settledAt: new Date().toISOString(),
          }),
        );
        if (!persistDecisions(`recover-settlement-${issue.number}`)) {
          results.push({
            issueNumber: issue.number,
            outcome: abandonedOutcome,
            prNumber: closedPr.number,
            reason: "settlement_persist_failed",
          });
          continue;
        }
        const fxRej = await applySettlementSideEffects({
          issue,
          label: labelForOutcome(abandonedOutcome),
          removeLabels: [LABELS.pendingMerge, LABELS.ratified],
          commentText: abandonedFromRatify
            ? `⚠️ PR #${closedPr.number} was closed without merge after a **ratified** vote (👍 ${frozenSettle?.votes?.up ?? "?"} / 👎 ${frozenSettle?.votes?.down ?? "?"}). The rule is **not active**. Vote outcome is preserved as \`ratified\` — reopen the PR or file a follow-up to enact it; closing this issue does not erase the tally.`
            : `❌ PR #${closedPr.number} was closed without merge. Rule is not active. Closing issue.`,
          shouldClose: !abandonedFromRatify,
          outcome: abandonedOutcome,
          via: "recover",
        });
        results.push({
          issueNumber: issue.number,
          outcome: fxRej.labelsOk ? abandonedOutcome : `${abandonedOutcome}_labels_failed`,
          prNumber: closedPr.number,
        });
        continue;
      }

      // No matching PR — do not close; maintainer may still open/fix one.
      results.push({ issueNumber: issue.number, outcome: "no_pr_found" });
      log(`  #${issue.number} pending but no PR matched branch rule/r*-from-${issue.number}`);
    } catch (err) {
      log(`  #${issue.number} recover error:`, String(err.message || err));
      results.push({
        issueNumber: issue.number,
        outcome: "recover_error",
        error: String(err.message).slice(0, 200),
      });
    }
  }
  return results;
}

function latestPreReviewPass(issueNumber) {
  if (!fs.existsSync(decisionsDir)) return null;
  const files = fs
    .readdirSync(decisionsDir)
    .filter((f) => f.startsWith(`pre-review-${issueNumber}-`) && f.endsWith(".json"))
    .sort();
  if (!files.length) return null;
  // Look backwards for the most recent "pass"
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(decisionsDir, files[i]), "utf8")
      );
      if (data.verdict === "pass" && data.snapshot) return data.snapshot;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Return `voting` issues whose snapshot is missing/incomplete to `proposal`.
 * Tooling failure must not become a proposal reject (C3 still guards settle).
 * Skips issues that already have a frozen settlement — those must resume side
 * effects via settlePhase, not re-enter `proposal`.
 */
async function reconcileVotingSnapshots() {
  const voting = await listOpenIssuesWithLabel(LABELS.voting);
  const results = [];
  for (const issue of voting) {
    try {
    const settled = latestSettlement(issue.number);
    if (settled?.outcome) {
      log(`reconcile: #${issue.number} has frozen settlement (${settled.outcome}) → leave for settle resume`);
      continue;
    }
    const snap = loadSnapshot(issue.number);
    const complete = snap && snap.proposalType && snap.ruleText;
    if (complete) continue;

    const recoveredSnap = latestPreReviewPass(issue.number);
    if (recoveredSnap && recoveredSnap.proposalType && recoveredSnap.ruleText) {
      log(`reconcile: #${issue.number} snapshot recovered from pre-review decisions`);
      writeSnapshot(issue.number, recoveredSnap);
      writeDecision(`reconcile-snapshot-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome: "snapshot_recovered",
        reconciledAt: new Date().toISOString(),
      });
      continue;
    }

    log(`reconcile: #${issue.number} voting without complete snapshot and no recovery available → proposal`);
    writeDecision(`reconcile-snapshot-${issue.number}-${Date.now()}.json`, {
      issueNumber: issue.number,
      outcome: "restored_to_proposal",
      hadSnapshot: Boolean(snap),
      snapshotComplete: complete,
      reconciledAt: new Date().toISOString(),
    });
    // Re-opened voting must not inherit the previous window's deadline.
    // Clear the deadline only after the label switch succeeds so a failed
    // restore cannot leave the issue in `voting` with no window bounds.
    try {
      await setLabels(issue.number, [LABELS.proposal], [LABELS.voting]);
    } catch (err) {
      writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome: "restored_to_proposal",
        error: String(err.message || err).slice(0, 300),
        at: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, action: "restore_label_failed" });
      continue;
    }
    resetVoteDeadline(issue.number, "snapshot_missing_restored_to_proposal");
    try {
      await commentOnce(
        issue.number,
        `<!-- aicanonfeed-reconciliation:${issue.number}:snapshot-restored -->`,
        `⚠️ Returned to \`proposal\`: pre-review snapshot was missing or incomplete (tooling/freeze failure). This is **not** a rejection — the proposal will be pre-reviewed again next cycle.`,
      );
    } catch (err) {
      log(`reconcile #${issue.number} comment failed:`, String(err.message || err));
    }
    results.push({ issueNumber: issue.number, action: "restored_to_proposal" });
    } catch (err) {
      log(`reconcile #${issue.number} crashed (continuing):`, String(err.message || err));
      results.push({ issueNumber: issue.number, action: "error", error: String(err.message || err).slice(0, 200) });
    }
  }
  return results;
}

/**
 * Close open issues that already carry a terminal result label.
 * Covers "label switched, close failed" so they do not linger forever.
 * Comments once per frozen settlement; pre-review comments use their own marker.
 */
async function reconcileOpenTerminal() {
  const terminal = [LABELS.ratified, LABELS.defeated, LABELS.expired, LABELS.rejected];
  const results = [];
  for (const lab of terminal) {
    let open = [];
    try {
      open = await listOpenIssuesWithLabel(lab);
    } catch (err) {
      log(`reconcile-terminal: list ${lab} failed:`, String(err.message || err));
      continue;
    }
    for (const issue of open) {
      try {
        const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
        // pending-merge is not terminal — recoverPendingPhase owns those.
        if (names.includes(LABELS.pendingMerge)) continue;
        if (names.includes(LABELS.voting) || names.includes(LABELS.proposal)) continue;
        const settle = latestSettlement(issue.number);
        // Frozen pass/reject only — a later tooling `verdict: "error"` must not
        // shadow a real terminal result and leave the issue stuck open.
        const pre = latestFrozenPreReview(issue.number);
        // Fail-closed: a terminal label alone is not a frozen result. Only close
        // when a settlement or pre-review reject record backs it — otherwise a
        // misapplied label would invent a "settlement" and close a live proposal.
        // An empty reason still counts: the verdict itself is the frozen result.
        const hasFrozen = hasFrozenTerminal(settle, pre);
        if (!hasFrozen) {
          log(`reconcile-terminal: #${issue.number} has \`${lab}\` but no frozen record — skip`);
          writeDecision(`terminal-reconcile-skipped-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            label: lab,
            action: "skipped_no_frozen_record",
            at: new Date().toISOString(),
          });
          continue;
        }
        // The live terminal label must match the frozen outcome's label.
        // A mismatch (e.g. frozen defeated but labeled ratified) is reported,
        // never closed under the wrong story.
        const outcome = settle?.outcome || (pre?.verdict === "reject" ? "rejected" : lab);
        const expectedLabel = labelForOutcome(outcome);
        if (expectedLabel !== lab) {
          log(
            `reconcile-terminal: #${issue.number} label \`${lab}\` ≠ frozen \`${expectedLabel}\` (${outcome}) — skip`,
          );
          writeDecision(`terminal-reconcile-skipped-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            label: lab,
            expectedLabel,
            outcome,
            action: "skipped_label_mismatch",
            at: new Date().toISOString(),
          });
          continue;
        }
        const alreadyCommented = settle
          ? hasSettlementComment(issue.number, settle)
          : pre?.verdict === "reject" &&
            hasPreReviewComment(issue.number, "reject");
        if (!alreadyCommented) {
          try {
            const text =
              `### Settlement — ${outcome} (reconciled)\n\n- result label \`${lab}\` was applied but the issue was left open; closing now.\n- votes were **not** re-tallied.`;
            if (settle) {
              await deliverSettlementComment(issue.number, settle, text, "reconcile");
            } else {
              await deliverPreReviewComment(issue.number, "reject", text, {
                verdict: "reject",
                via: "reconcileOpenTerminal",
              });
            }
          } catch (err) {
            log(`reconcile-terminal #${issue.number} comment failed:`, String(err.message || err));
            results.push({ issueNumber: issue.number, action: "comment_failed", label: lab });
            continue;
          }
        }
        await closeIssue(issue.number);
        writeDecision(`terminal-reconciled-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome,
          label: lab,
          action: "closed",
          at: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, action: "closed", label: lab });
      } catch (err) {
        log(`reconcile-terminal #${issue.number} failed:`, String(err.message || err));
        results.push({
          issueNumber: issue.number,
          action: "error",
          error: String(err.message || err).slice(0, 200),
        });
      }
    }
  }
  return results;
}

function hasDecisionPrefix(prefix) {
  if (!fs.existsSync(decisionsDir)) return false;
  return fs.readdirSync(decisionsDir).some((f) => f.startsWith(prefix) && f.endsWith(".json"));
}

function hasPreReviewComment(issueNumber, kind) {
  if (!fs.existsSync(decisionsDir)) return false;
  const prefix = `pre-review-commented-${issueNumber}-`;
  return fs.readdirSync(decisionsDir).some((file) => {
    if (!file.startsWith(prefix) || !file.endsWith(".json")) return false;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(decisionsDir, file), "utf8"));
      if (record.commentKind) return record.commentKind === kind;
      return (kind === "pass" && record.verdict === "pass") ||
        (kind === "reject" && record.verdict === "reject");
    } catch {
      return false;
    }
  });
}

async function deliverPreReviewComment(issueNumber, kind, body, details = {}) {
  if (hasPreReviewComment(issueNumber, kind)) return { created: false, knownDelivered: true };
  const marker =
    `<!-- aicanonfeed-pre-review:${issueNumber}:${encodeURIComponent(kind)} -->`;
  const result = await commentOnce(issueNumber, marker, body);
  writeDecision(`pre-review-commented-${issueNumber}-${kind}-${Date.now()}.json`, {
    issueNumber,
    commentKind: kind,
    ...details,
    marker,
    at: new Date().toISOString(),
  });
  return result;
}

function hasSettlementComment(issueNumber, settlement) {
  if (!fs.existsSync(decisionsDir)) return false;
  const prefix = `settle-commented-${issueNumber}-`;
  const identity = settlementCommentIdentity(settlement);
  return fs.readdirSync(decisionsDir).some((file) => {
    if (!file.startsWith(prefix) || !file.endsWith(".json")) return false;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(decisionsDir, file), "utf8"));
      return record.settlementIdentity === identity;
    } catch {
      return false;
    }
  });
}

async function deliverSettlementComment(issueNumber, settlement, body, via) {
  const identity = settlementCommentIdentity(settlement);
  // Idempotent: a recover retry must not mint another public comment.
  if (hasSettlementComment(issueNumber, settlement)) {
    return { created: false, knownDelivered: true };
  }
  const kind = via === "retry_pr" ? "retry-pr" : "settlement";
  const marker = settlementCommentMarker(issueNumber, settlement, kind);
  const canonicalMarker = settlementCommentMarker(issueNumber, settlement);
  const commentBody =
    kind === "settlement" ? body : `${body}\n\n${canonicalMarker}`;
  await commentOnce(issueNumber, marker, commentBody);
  writeDecision(`settle-commented-${issueNumber}-${Date.now()}.json`, {
    issueNumber,
    outcome: settlement?.outcome || "unknown",
    voteOutcome: settlement?.voteOutcome || null,
    settledAt: settlement?.settledAt || null,
    settlementIdentity: identity,
    marker,
    via,
    at: new Date().toISOString(),
  });
}

/** Restore `proposal` on open unlabeled rule filings (label switch failed mid-flight). */
async function reconcileOrphanProposals() {
  const results = [];
  let open = [];
  try {
    open = await listIssues({ state: "open", maxPages: 30 });
  } catch (err) {
    // Truncated/failed listing must not look like "no orphans to fix".
    log("reconcile-orphans: listIssues failed (skip this cycle):", String(err.message || err));
    return results;
  }
  const processLabels = new Set([
    LABELS.proposal,
    LABELS.voting,
    LABELS.rejected,
    LABELS.ratified,
    LABELS.pendingMerge,
    LABELS.defeated,
    LABELS.expired,
    // do-not-merge marks an abandoned ratified PR (or a maintainer kill switch).
    // Never "restore" those back into the proposal/voting queue.
    LABELS.doNotMerge,
  ]);
  for (const issue of open) {
    try {
    const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    if (names.some((n) => processLabels.has(n))) continue;
    // A frozen terminal settlement also means the filing has left the pipeline,
    // even if label writes failed mid-flight.
    const settle = latestSettlement(issue.number);
    if (
      settle?.outcome &&
      !String(settle.outcome).startsWith("deferred") &&
      settle.outcome !== "needs_manual" &&
      settle.outcome !== "ratified_pending_merge"
    ) {
      continue;
    }
    const body = String(issue.body || "");
    if (!/##\s*Proposal Type/i.test(body)) continue;
    log(`reconcile-orphans: #${issue.number} unlabeled filing → proposal`);
    writeDecision(`reconcile-orphan-${issue.number}-${Date.now()}.json`, {
      issueNumber: issue.number,
      action: "restored_proposal_label",
      at: new Date().toISOString(),
    });
    try {
      await setLabels(issue.number, [LABELS.proposal], []);
    } catch (err) {
      writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        outcome: "restored_proposal_label",
        error: String(err.message || err).slice(0, 300),
        at: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, action: "restore_label_failed" });
      continue;
    }
    try {
      await commentOnce(
        issue.number,
        `<!-- aicanonfeed-reconciliation:${issue.number}:orphan-proposal-restored -->`,
        `⚠️ Restored \`proposal\` label (issue had no process labels). This is **not** a rejection.`,
      );
    } catch (err) {
      log(`reconcile-orphans #${issue.number} comment failed:`, String(err.message || err));
    }
    results.push({ issueNumber: issue.number, action: "restored_proposal_label" });
    } catch (err) {
      log(`reconcile-orphans #${issue.number} crashed (continuing):`, String(err.message || err));
      results.push({ issueNumber: issue.number, action: "error", error: String(err.message || err).slice(0, 200) });
    }
  }
  return results;
}

async function preReviewPhase({ metaRules, prompt, stars, rulesFresh = true }) {
  const proposals = await listOpenIssuesWithLabel(LABELS.proposal);
  log(`pre-review: ${proposals.length} proposal(s)`);
  const results = [];
  const promptBody = loadPrompt(prompt);

  // Proposal quota facts: count ALL in-flight states (proposal/voting/pending merge).
  // If any queue listing fails, the quota picture is incomplete — defer the whole
  // pre-review pass instead of treating a missing queue as empty (fail-closed).
  const inFlightLabels = [LABELS.proposal, LABELS.voting, LABELS.pendingMerge];
  const inFlightIssues = [];
  const quotaListErrors = [];
  for (const lab of inFlightLabels) {
    try {
      inFlightIssues.push(...(await listOpenIssuesWithLabel(lab)));
    } catch (err) {
      quotaListErrors.push(`${lab}: ${String(err.message || err).slice(0, 120)}`);
      log(`quota: list ${lab} failed:`, String(err.message || err));
    }
  }
  if (quotaListErrors.length) {
    log(`pre-review deferred: incomplete in-flight lists (${quotaListErrors.join("; ")})`);
    writeDecision(`pre-review-deferred-${Date.now()}.json`, {
      reason: "quota_facts_incomplete",
      errors: quotaListErrors,
      deferredAt: new Date().toISOString(),
    });
    return results;
  }
  const seenIssueNums = new Set();
  const openByAuthor = new Map();
  for (const issue of inFlightIssues) {
    if (seenIssueNums.has(issue.number)) continue;
    seenIssueNums.add(issue.number);
    const key = String(issue.user?.login || "").toLowerCase();
    if (!openByAuthor.has(key)) openByAuthor.set(key, []);
    openByAuthor.get(key).push({
      number: issue.number,
      createdAt: issue.created_at || null,
    });
  }
  const dayCache = new Map();
  /** Rule proposals created on the same UTC day as `anchorCreatedAt` (not the run date). */
  async function createdOnSameDayAs(login, anchorCreatedAt, issueNumber) {
    const key = String(login || "").toLowerCase();
    const dayStart = startOfUtcDay(
      Number.isFinite(Date.parse(String(anchorCreatedAt || "")))
        ? Date.parse(String(anchorCreatedAt))
        : Date.now(),
    );
    const cacheKey = `${key}|${dayStart}`;
    if (!dayCache.has(cacheKey)) {
      // Search by created:day. Do NOT fall back to list+since on search failure —
      // that path is updated_at-based and can exhaust pagination on long histories,
      // turning a transient search error into a permanent quota defer.
      const issues = await listIssuesCreatedOnDay({
        creator: login,
        day: dayStart.slice(0, 10),
      });
      // Daily quota counts rule proposals only — ordinary feedback/bug
      // issues must not consume the rule-proposal budget. Day boundary is the
      // proposal's own creation day, so a delayed pre-review cannot let a
      // second same-day filing through after the first leaves the in-flight queue.
      // Counting uses body + process labels (stable): a body edit after filing
      // must not uncount a same-day sibling.
      const rows = filterCreatedOnUtcDay(issues, anchorCreatedAt)
        .filter((i) =>
          countsTowardProposalQuota({
            body: i.body || "",
            labels: i.labels || [],
            // Process labels mean "entered the governance pipeline". Exclude
            // do-not-merge (a merge brake, not a filing) so anyone tagging an
            // issue cannot burn an author's daily proposal slot.
            processLabels: Object.values(LABELS).filter((n) => n !== LABELS.doNotMerge),
          }),
        )
        .map((i) => ({ number: i.number, createdAt: i.created_at || null }));
      dayCache.set(cacheKey, rows);
    }
    const rows = dayCache.get(cacheKey);
    // Always include the proposal under review (same day as itself by definition).
    // Mutate the cache so a later same-day sibling still sees this filing.
    if (!rows.some((r) => Number(r.number) === Number(issueNumber))) {
      rows.push({ number: issueNumber, createdAt: anchorCreatedAt || null });
    }
    return rows;
  }

  for (const issue of proposals) {
    try {
    // A prior hard reject is final. If labels failed then, restore side effects
    // only — never re-judge (quota is date-sensitive and would flip the verdict).
    // Restore on verdict alone; an empty reason must not force a re-run.
    // Tooling errors must not shadow a frozen pass/reject.
    const priorDecision = latestFrozenPreReview(issue.number);
    const priorReject = priorDecision?.verdict === "reject" ? priorDecision : null;
    // A prior pass is also frozen: snapshot is already committed. If the switch
    // to `voting` failed, retry that switch only — never re-run gates/model.
    const priorPass = priorDecision?.verdict === "pass" ? priorDecision : null;
    if (priorReject) {
      log(`pre-review #${issue.number} resume frozen reject (${priorReject.reason}) — no re-judge`);
      try {
        await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal, LABELS.voting]);
      } catch (err) {
        writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome: "rejected",
          resumed: true,
          error: String(err.message || err).slice(0, 300),
          at: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, verdict: "reject", resumed: true, labelsOk: false });
        continue;
      }
      let commentDelivered = hasPreReviewComment(issue.number, "reject");
      if (!commentDelivered) {
        try {
          await deliverPreReviewComment(
            issue.number,
            "reject",
            `❌ Pre-review rejected (resumed).\n\n${priorReject.reason}\n\nMatched meta-rules: ${(priorReject.matchedMetaRules || []).join(", ") || "n/a"}`,
            { verdict: "reject", resumed: true },
          );
          commentDelivered = true;
        } catch (err) {
          log(`pre-review #${issue.number} resume comment failed:`, String(err.message || err));
        }
      }
      if (commentDelivered) {
        try {
          await closeIssue(issue.number);
        } catch (err) {
          log(`pre-review #${issue.number} resume close failed:`, String(err.message || err));
          writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "rejected",
            label: LABELS.rejected,
            phase: "close",
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
        }
      }
      results.push({ issueNumber: issue.number, verdict: "reject", resumed: true });
      continue;
    }
    if (priorPass) {
      log(`pre-review #${issue.number} resume frozen pass — switch to voting only`);
      // A frozen pass without a usable snapshot must not enter voting: settle
      // would either reject (old C3) or tally without frozen quorum/fields.
      // Try rebuild from the frozen decision's embedded snapshot first.
      let resumeSnap = loadSnapshot(issue.number);
      let resumeSnapComplete = Boolean(
        resumeSnap && resumeSnap.proposalType && resumeSnap.ruleText,
      );
      if (
        snapshotFreezeDisposition({
          hasFrozenPass: true,
          snapshotComplete: resumeSnapComplete,
        }) === "defer"
      ) {
        const rebuilt = rebuildSnapshotFromFrozenPass(issue.number, priorPass);
        if (rebuilt) {
          const snapRel = path.relative(ROOT, snapshotPath(issue.number));
          const rebuildCommit = commitPaths(
            [snapRel],
            `chore: rebuild lost pre-review snapshot #${issue.number}`,
          );
          if (rebuildCommit.ok) {
            log(`pre-review #${issue.number} rebuilt lost snapshot from frozen pass`);
            resumeSnap = rebuilt;
            resumeSnapComplete = true;
          } else {
            log(`pre-review #${issue.number} snapshot rebuild commit failed — defer`);
            writeDecision(`pre-review-deferred-${issue.number}-${Date.now()}.json`, {
              issueNumber: issue.number,
              reason: "snapshot_rebuild_commit_failed",
              error: String(rebuildCommit.error || "").slice(0, 200),
              deferredAt: new Date().toISOString(),
            });
            results.push({ issueNumber: issue.number, verdict: "deferred", snapshotLost: true });
            continue;
          }
        } else {
          await markSnapshotNeedsManual(issue.number, priorPass);
          results.push({ issueNumber: issue.number, verdict: "needs_manual", snapshotLost: true });
          continue;
        }
      }
      // Notify first so a comment failure keeps the issue in `proposal`.
      // Rebuild the full vote conditions from the committed snapshot so the
      // resumed notice matches the original one (quorum / stars / age gate).
      if (!hasPreReviewComment(issue.number, "pass")) {
        const snap = resumeSnap;
        const q = snap?.quorumAtVotingStart ?? priorPass.quorum ?? quorumForStars(stars);
        const s = snap?.starsAtVotingStart ?? priorPass.starsAtVotingStart ?? stars;
        const resumeNotify =
          `✅ Pre-review passed (resumed from frozen decision). Entered this cycle's vote.\n\n` +
          `**Vote deadline:** the next governance settle run (Mon 03:00 UTC) — reactions after that are not counted.\n` +
          `**Quorum (frozen at voting start):** ${q} approvals · starsAtVotingStart=${s} · account age ≥ ${MIN_ACCOUNT_AGE_DAYS} days required.\n` +
          `Settles next governance cycle.`;
        try {
          await deliverPreReviewComment(
            issue.number,
            "pass",
            resumeNotify,
            { verdict: "pass", resumed: true },
          );
        } catch (err) {
          log(`pre-review #${issue.number} resume-pass comment failed:`, String(err.message || err));
          results.push({ issueNumber: issue.number, verdict: "pass", resumed: true, notifyFailed: true });
          continue;
        }
      }
      try {
        // Keep any window already opened by a prior pass attempt — a reset
        // would drop votes cast before the label switch finally succeeded.
        ensureVoteWindow(issue.number, "pre_review_pass_resumed");
        if (!persistDecisions(`vote-window-${issue.number}`)) {
          results.push({ issueNumber: issue.number, verdict: "pass", resumed: true, persistFailed: true });
          continue;
        }
        await setLabels(issue.number, [LABELS.voting], [LABELS.proposal]);
      } catch (err) {
        writeDecision(`settle-label-error-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome: "pass",
          resumed: true,
          error: String(err.message || err).slice(0, 300),
          at: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, verdict: "pass", resumed: true, labelsOk: false });
        continue;
      }
      results.push({ issueNumber: issue.number, verdict: "pass", resumed: true });
      continue;
    }
    const login = issue.user?.login || "";
    const openList = openByAuthor.get(String(login).toLowerCase()) || [];
    let createdToday;
    try {
      createdToday = await createdOnSameDayAs(login, issue.created_at, issue.number);
    } catch (err) {
      // Daily-quota fact unavailable — defer this issue, never treat as empty.
      log(`pre-review #${issue.number} createdToday failed:`, String(err.message || err));
      writeDecision(`pre-review-deferred-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        reason: "quota_facts_incomplete:created_today",
        error: String(err.message || err).slice(0, 200),
        deferredAt: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "deferred" });
      continue;
    }
    const quota = evaluateProposalQuota({
      login,
      stars,
      issueNumber: issue.number,
      openByAuthor: openList,
      createdTodayByAuthor: createdToday,
    });
    if (!quota.ok) {
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "reject",
        reason: quota.reason,
        matchedMetaRules: ["M3"],
        reviewedAt: new Date().toISOString(),
      });
      if (!persistDecisions(`pre-review-quota-reject-${issue.number}`)) {
        results.push({ issueNumber: issue.number, verdict: "reject", persistFailed: true });
        continue;
      }
      await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
      let commentDelivered = false;
      try {
        await deliverPreReviewComment(
          issue.number,
          "reject",
          quota.message,
          { verdict: "reject", reason: quota.reason },
        );
        commentDelivered = true;
      } catch (err) {
        log(`pre-review #${issue.number} quota comment failed:`, String(err.message || err));
      }
      if (commentDelivered) {
        try {
          await closeIssue(issue.number);
        } catch (err) {
          log(`pre-review #${issue.number} quota close failed:`, String(err.message || err));
          writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "rejected",
            label: LABELS.rejected,
            phase: "close",
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
        }
      }
      results.push({ issueNumber: issue.number, verdict: "reject" });
      continue;
    }

    // Hard shape gates (shared with tests via evaluateProposalBody) before any LLM call.
    const gate = evaluateProposalBody(issue.body || "", {
      rulesDir: path.join(ROOT, "rules"),
    });
    if (!gate.ok) {
      // Rules-dependent misses (target/group not on disk, inactive, category
      // mismatch) must not hard-reject when the local checkout is stale — a
      // just-merged group/rule would otherwise freeze a wrong "not found".
      const gateDisposition = rulesDependentGateDisposition({
        rulesFresh,
        code: gate.code,
      });
      if (gateDisposition === "defer") {
        log(`pre-review #${issue.number} deferred: rules stale, gate ${gate.code}`);
        writeDecision(`pre-review-deferred-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          reason: `rules_stale:${gate.code}`,
          gateCode: gate.code,
          rulesFresh: false,
          deferredAt: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, verdict: "deferred", gateCode: gate.code });
        continue;
      }
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "reject",
        reason: gate.reason,
        matchedMetaRules: gate.matchedMetaRules,
        reviewedAt: new Date().toISOString(),
      });
      if (!persistDecisions(`pre-review-reject-${issue.number}`)) {
        // Freeze is local-only so far — do not close yet; retry next cycle.
        results.push({ issueNumber: issue.number, verdict: "reject", persistFailed: true });
        continue;
      }
      await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
      let commentDelivered = false;
      try {
        await deliverPreReviewComment(
          issue.number,
          "reject",
          gate.message,
          { verdict: "reject", reason: gate.reason },
        );
        commentDelivered = true;
      } catch (err) {
        log(`pre-review #${issue.number} gate comment failed:`, String(err.message || err));
      }
      if (commentDelivered) {
        try {
          await closeIssue(issue.number);
        } catch (err) {
          log(`pre-review #${issue.number} gate close failed:`, String(err.message || err));
          writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "rejected",
            label: LABELS.rejected,
            phase: "close",
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
        }
      }
      results.push({ issueNumber: issue.number, verdict: "reject" });
      continue;
    }

    // Stale positive: gate.ok still relied on local rules/ (target on disk,
    // status active, category match). Never freeze pass on a stale checkout —
    // remote may already have revoked / deactivated / recategorized the target.
    if (!rulesFresh) {
      log(`pre-review #${issue.number} deferred: rules stale, cannot verify target`);
      writeDecision(`pre-review-deferred-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        reason: "rules_stale:cannot_verify_target",
        rulesFresh: false,
        deferredAt: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "deferred", gateCode: "rules_stale" });
      continue;
    }

    const pType = gate.fields.proposalType;
    const targetRuleId = gate.fields.targetRuleId;
    let category = gate.fields.category;
    const ruleText = gate.fields.ruleText;

    const filled = fillTemplate(promptBody, {
      META_RULES: metaRules,
      ISSUE_BODY: sanitizeUntrusted(issue.body || ""),
    });
    const verdictRes = await chatJSON({
      system: filled,
      user: "Apply the policy above to the untrusted content already included and return JSON.",
    }).catch((err) => ({
      verdict: "error",
      reason: String(err.message).slice(0, 300),
      error: true,
    }));

    // Infra/LLM failure: keep the proposal open for the next cycle — never hard-reject.
    // Schema-invalid JSON is also a tooling error (not a permanent reject).
    const normalized = verdictRes.error === true || verdictRes.verdict === "error"
      ? { ok: false, error: String(verdictRes.reason || "unknown error").slice(0, 400) }
      : normalizeModelVerdict(verdictRes);
    if (!normalized.ok) {
      const errReason = normalized.error || "unknown error";
      const prev = latestPreReview(issue.number);
      // Dedupe: only comment when the previous outcome was not also an error.
      if (prev?.verdict !== "error") {
        try {
          await deliverPreReviewComment(
            issue.number,
            "error",
            `⚠️ Pre-review skipped (tooling error). Proposal stays in \`proposal\` and will retry next cycle.\n\n\`${errReason}\``,
            { verdict: "error" },
          );
        } catch (err) {
          log(`pre-review #${issue.number} error comment failed:`, String(err.message || err));
        }
      }
      // Tooling record — prefix avoids shadowing a frozen pass/reject.
      writeDecision(`pre-review-commit-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "error",
        reason: errReason,
        matchedMetaRules: [],
        reviewedAt: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "error" });
      continue;
    }

    const verdict = normalized.verdict;
    const reason = String(normalized.reason || verdictRes.reason || "").slice(0, 400);
    const matched = Array.isArray(verdictRes.matchedMetaRules)
      ? verdictRes.matchedMetaRules.filter((m) => /^M[1-7]$/.test(m))
      : [];

    if (verdict === "pass") {
      // Freeze the reviewed gate.fields (not a re-parse) + evidence contract.
      const frozenSnapshot = {
        issueNumber: issue.number,
        category: gate.fields.category,
        ruleText: gate.fields.ruleText,
        proposalType: gate.fields.proposalType,
        targetRuleId: gate.fields.targetRuleId || null,
        targetGroup: gate.fields.targetGroup || null,
        evidenceContract: gate.fields.evidenceContract || {
          requiresEvidence: [],
          evidenceAny: [],
          declared: false,
        },
        starsAtVotingStart: stars,
        quorumAtVotingStart: quorumForStars(stars),
        voteDeadline: "settle",
        voteWindowStartAt: new Date().toISOString(),
        snapshotAt: new Date().toISOString(),
      };
      writeSnapshot(issue.number, frozenSnapshot);
      // Persist pre-review record BEFORE labels. Embed the full snapshot so a
      // lost rule-snapshots file can be rebuilt without re-parsing the body.
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "pass",
        reason,
        proposalType: pType,
        targetRuleId: targetRuleId || null,
        matchedMetaRules: matched,
        evidenceContract: gate.fields.evidenceContract || null,
        snapshot: frozenSnapshot,
        reviewedAt: new Date().toISOString(),
      });
      const snapRel = path.relative(ROOT, snapshotPath(issue.number));
      // Commit BOTH the snapshot and the frozen pass decision — snapshot-only
      // leaves a `voting` label on remote with no proof the pre-review passed.
      const commitRes = commitPaths(
        [snapRel, "decisions"],
        `chore: freeze pre-review snapshot + pass #${issue.number}`,
      );
      if (!commitRes.ok) {
        const errReason = String(commitRes.error || "snapshot commit failed").slice(0, 300);
        // Tooling failure — do NOT overwrite the frozen `pass` verdict.
        writeDecision(`pre-review-commit-error-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          verdict: "error",
          reason: `snapshot commit failed: ${errReason}`,
          matchedMetaRules: [],
          reviewedAt: new Date().toISOString(),
        });
        try {
          await deliverPreReviewComment(
            issue.number,
            "snapshot-error",
            `⚠️ Pre-review could not freeze the snapshot (git commit/push failed). Stays in \`proposal\` and will retry next cycle.\n\n\`${errReason}\``,
            { verdict: "error" },
          );
        } catch (err) {
          log(`pre-review #${issue.number} commit-error comment failed:`, String(err.message || err));
        }
        results.push({ issueNumber: issue.number, verdict: "error" });
        continue;
      }
      // Notify BEFORE the label switch so a comment failure leaves the issue in
      // `proposal` for a retry. After labels land the issue leaves this queue and
      // a missing notification would never be reconciled.
      const passNotify =
        `✅ Pre-review passed (\`${pType}\`${targetRuleId ? ` → ${targetRuleId}` : ""}). Entered this cycle's vote.\n\n` +
        `**Vote deadline:** the next governance settle run (Mon 03:00 UTC) — reactions after that are not counted.\n` +
        `**Quorum (frozen at voting start):** ${quorumForStars(stars)} approvals · starsAtVotingStart=${stars} · account age ≥ ${MIN_ACCOUNT_AGE_DAYS} days required.\n` +
        `Settles next governance cycle.`;
      if (!hasPreReviewComment(issue.number, "pass")) {
        try {
          await deliverPreReviewComment(
            issue.number,
            "pass",
            passNotify,
            { verdict: "pass" },
          );
        } catch (err) {
          log(`pre-review #${issue.number} pass notify failed (stay in proposal):`, String(err.message || err));
          writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "pass",
            label: LABELS.proposal,
            phase: "comment",
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
          results.push({ issueNumber: issue.number, verdict: "pass", notifyFailed: true });
          continue;
        }
      }
      // New voting window — never inherit a prior window's deadline.
      openVoteWindow(issue.number, "pre_review_pass");
      // Persist the window start BEFORE the label switch so a killed job cannot
      // leave remote `voting` without a recoverable window start.
      if (!persistDecisions(`vote-window-${issue.number}`)) {
        results.push({ issueNumber: issue.number, verdict: "pass", persistFailed: true });
        continue;
      }
      await setLabels(issue.number, [LABELS.voting], [LABELS.proposal]);
    } else {
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict,
        reason,
        proposalType: pType,
        targetRuleId: targetRuleId || null,
        matchedMetaRules: matched,
        evidenceContract: gate.fields.evidenceContract || null,
        reviewedAt: new Date().toISOString(),
      });
      if (!persistDecisions(`pre-review-reject-${issue.number}`)) {
        results.push({ issueNumber: issue.number, verdict: "reject", persistFailed: true });
        continue;
      }
      await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
      let commentDelivered = false;
      try {
        await deliverPreReviewComment(
          issue.number,
          "reject",
          `❌ Pre-review rejected.\n\n${reason}\n\nMatched meta-rules: ${matched.join(", ") || "n/a"}`,
          { verdict, reason },
        );
        commentDelivered = true;
      } catch (err) {
        log(`pre-review #${issue.number} reject comment failed:`, String(err.message || err));
      }
      if (commentDelivered) {
        try {
          await closeIssue(issue.number);
        } catch (err) {
          // Left open with `rejected` — reconcileOpenTerminal will close next cycle.
          log(`pre-review #${issue.number} reject close failed:`, String(err.message || err));
          writeDecision(`settle-followup-error-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "rejected",
            label: LABELS.rejected,
            phase: "close",
            error: String(err.message || err).slice(0, 300),
            at: new Date().toISOString(),
          });
        }
      }
    }
    results.push({ issueNumber: issue.number, verdict });
    } catch (err) {
      log(`pre-review #${issue.number} crashed (continuing):`, String(err.message || err));
      writeDecision(`pre-review-error-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        error: String(err.message || err).slice(0, 400),
        at: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "error" });
    }
  }
  return results;
}

async function main() {
  const repo = await getRepo();
  const stars = repo.stargazers_count || 0;
  const stageInfo = stageForStars(stars);
  log(`repo=${repoSlug()} stars=${stars} stage=${stageInfo.stage} quorum=${stageInfo.quorum}`);

  const { groups, items, skipped } = loadActiveRules(path.join(ROOT, "rules"));
  log(`active items: ${items.map((r) => r.id).join(", ") || "(none)"}`);
  log(`active groups: ${groups.map((g) => g.id).join(", ") || "(none)"}`);
  if (skipped.length) log("skipped rules:", skipped);

  const metaRules = fs.readFileSync(path.join(ROOT, "lib", "meta-rules.md"), "utf8");
  const prompt = fs.readFileSync(
    path.join(ROOT, "lib", "prompts", "rule-pre-review.md"),
    "utf8",
  );

  // Reserve ids from every rules/*.md plus open rule PR branches.
  const diskIds = reservedRuleIds(path.join(ROOT, "rules"));
  let openPulls = null;
  let pullErr = null;
  for (let attempt = 0; attempt < 3 && !openPulls; attempt++) {
    try {
      openPulls = await listPulls({ state: "open" });
    } catch (err) {
      pullErr = err;
      log(`listPulls attempt ${attempt + 1} failed:`, String(err.message || err));
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  if (!openPulls) {
    // Empty pull list would let reservedIds forget frozen/open rule branches.
    // Fail closed: rethrow so the cycle does not allocate duplicate rule ids.
    throw new Error(`listPulls failed: ${String(pullErr?.message || pullErr).slice(0, 200)}`);
  }
  const branchIds = ruleIdsFromBranches(openPulls.map((p) => p.head?.ref));
  // Also reserve ids frozen into settlement records whose PR may not exist yet.
  const frozenIds = frozenNextIds();
  const reservedIds = new Set([...diskIds, ...branchIds, ...frozenIds]);
  log(`reserved rule ids: ${[...reservedIds].sort().join(", ") || "(none)"}`);

  // Recover pending merges first so ratified rules can activate before new settles.
  let recovered = [];
  try {
    recovered = await recoverPendingPhase({ stars });
  } catch (err) {
    log("recover-pending crashed (continuing):", String(err.message || err));
  }
  let reconciled = [];
  try {
    reconciled = await reconcileVotingSnapshots();
  } catch (err) {
    log("reconcile-snapshots crashed (continuing):", String(err.message || err));
  }
  try {
    await reconcileOrphanProposals();
  } catch (err) {
    log("reconcile-orphans crashed (continuing):", String(err.message || err));
  }
  let terminalReconciled = [];
  try {
    terminalReconciled = await reconcileOpenTerminal();
  } catch (err) {
    log("reconcile-terminal crashed (continuing):", String(err.message || err));
  }
  // Decision files written above dirty the worktree and would block ff-sync.
  // Commit them first, then fast-forward so same-cycle rule merges are visible
  // to findRuleFile() during settle.
  const decisionsCommit = commitPaths(
    ["decisions"],
    "chore: record governance recover/reconcile decisions",
  );
  log("commit decisions:", JSON.stringify(decisionsCommit));
  const synced = syncWithOrigin();
  log("syncWithOrigin:", JSON.stringify(synced));
  // If we cannot confirm the on-disk rules match origin, never reject a
  // proposal for "target rule/group not found" — that may be a stale checkout.
  let rulesFresh = Boolean(synced.ok);
  // Settle voting, then pre-review new proposals.
  const settled = await settlePhase({ stars, stageInfo, reservedIds, rulesFresh });
  const settleCommit = commitPaths(
    ["decisions"],
    "chore: persist settlements before proposal pre-review",
  );
  const preReviewSync = settleCommit.ok
    ? syncWithOrigin()
    : { ok: false, error: settleCommit.error || "settlement decision commit failed" };
  rulesFresh = Boolean(preReviewSync.ok);
  log("rules sync before pre-review:", JSON.stringify(preReviewSync));
  const reviewed = await preReviewPhase({ metaRules, prompt, stars, rulesFresh });

  const summary = {
    ranAt: new Date().toISOString(),
    stage: stageInfo,
    recovered,
    reconciled,
    terminalReconciled,
    settled,
    reviewed,
    evidenceEngineVersion: EVIDENCE_ENGINE_VERSION,
  };
  writeDecision(`cycle-summary-${Date.now()}.json`, summary);
  log("done", JSON.stringify(summary));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
