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
  listIssueReactions,
  setLabels,
  comment,
  closeIssue,
  upsertFilePr,
  getPull,
  listPulls,
  mergePullRequest,
  pullIsMerged,
  splitSlug,
  repoSlug,
} from "../lib/github.mjs";
import { stageForStars, quorumForStars, canAutoMerge, AUTO_MERGE_MIN_STARS, MIN_ACCOUNT_AGE_DAYS, LABELS, RULE_MAX_CHARS, RULE_MAX_CHARS_GROUP, isCategory, parseRuleId, isGroupRule, FOUNDER_LOGIN, FOUNDER_STAR_CEILING } from "../lib/constants.mjs";
import { tallyVotes, settleOutcome, applyFounderVote } from "../lib/voting.mjs";
import { chatJSON, loadPrompt, fillTemplate } from "../lib/llm.mjs";
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
  buildRuleFile,
  nextFreeItemNumber,
  nextFreeGroupNumber,
} from "../lib/rules.mjs";
import { scanRuleText } from "../lib/rule-guard.mjs";

const ROOT = process.cwd();
const decisionsDir = path.join(ROOT, "decisions", "rule-reviews");
const snapshotsDir = path.join(ROOT, "decisions", "rule-snapshots");

function log(...args) {
  console.log("[governance]", ...args);
}

function writeDecision(name, payload) {
  fs.mkdirSync(decisionsDir, { recursive: true });
  const file = path.join(decisionsDir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function snapshotPath(issueNumber) {
  return path.join(snapshotsDir, `${issueNumber}.json`);
}

function writeSnapshot(issueNumber, payload) {
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(snapshotPath(issueNumber), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function loadSnapshot(issueNumber) {
  const file = snapshotPath(issueNumber);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Latest pre-review decision for an issue (for error-comment dedupe). */
function latestPreReview(issueNumber) {
  if (!fs.existsSync(decisionsDir)) return null;
  const files = fs
    .readdirSync(decisionsDir)
    .filter((f) => f.startsWith(`pre-review-${issueNumber}-`) && f.endsWith(".json"))
    .sort();
  if (!files.length) return null;
  try {
    return JSON.parse(
      fs.readFileSync(path.join(decisionsDir, files[files.length - 1]), "utf8"),
    );
  } catch {
    return null;
  }
}

function ruleFileName(id, category) {
  return `rules/${id}.md`;
}

function guardRule({ text, category, nextId, existingIds }) {
  if (!text || text.length < 20) return "Rule text too short";
  if (text.length > RULE_MAX_CHARS) return "Rule text too long";
  if (/<script|javascript:|onerror=/i.test(text)) return "Rule text contains unsafe markup";
  const unsafe = scanRuleText(text);
  if (unsafe) return `Rule text rejected (${unsafe})`;
  if (!isCategory(category)) return "Invalid category";
  if (existingIds.has(nextId)) return `Rule ID ${nextId} already exists`;
  return null;
}

/** created_at map for reaction logins. Lookup failure → { ok: false } (unknown ≠ young). */
async function resolveCreatedAt(reactions) {
  const logins = [];
  for (const r of reactions || []) {
    if (r.user?.login) logins.push(r.user.login);
  }
  return resolveUserCreatedAts(logins);
}

async function settlePhase({ stars, stageInfo, reservedIds }) {
  const voting = await listOpenIssuesWithLabel(LABELS.voting);
  log(`settle: ${voting.length} voting issue(s), quorum=${stageInfo.quorum}`);
  const results = [];
  const { owner, repo } = splitSlug();
  // Include on-disk ids and open-PR branch ids so pending rules cannot be reallocated.
  const usedIds = new Set(reservedIds);

  for (const issue of voting) {
    const snap0 = loadSnapshot(issue.number);
    // Quorum + F1 freeze at voting entry (starsAtVotingStart). Fall back to live stars for legacy issues.
    const starsForVote = snap0?.starsAtVotingStart ?? stars;
    const quorumForVote = snap0?.quorumAtVotingStart ?? stageInfo.quorum;
    const reactions = await listIssueReactions(issue.number);
    const createdAtByLogin = await resolveCreatedAt(reactions);
    const tally = tallyVotes(reactions, issue.user?.login, {
      minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
      getCreatedAt: (login) => createdAtByLogin.get(login) ?? { ok: false, createdAt: null },
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

    let prNumber = null;
    let prUrl = null;
    let skippedMerge = false;
    let guardError = null;

    if (outcome === "ratified") {
      const snap = snap0;
      const pType = snap?.proposalType || parseProposalType(issue.body || "");
      let category = parseCategory(issue.body || "");
      let text = parseRuleText(issue.body || "");
      let targetRuleId = snap?.targetRuleId || parseTargetRule(issue.body || "");
      let targetGroup = snap?.targetGroup || parseTargetGroup(issue.body || "");

      // C3: reject if no snapshot — prevents pre-review bypass via manual `voting` label
      if (!snap || !snap.proposalType || !snap.ruleText) {
        guardError = "Missing or incomplete pre-review snapshot";
        outcome = "rejected_by_guard";
      } else {
        // Prefer the pre-review snapshot so post-vote body edits cannot change the rule.
        const liveCategory = parseCategory(issue.body || "");
        const liveText = parseRuleText(issue.body || "");
        const liveTarget = parseTargetRule(issue.body || "");
        const liveType = parseProposalType(issue.body || "");
        const liveTargetGroup = parseTargetGroup(issue.body || "");
        if (
          (liveType && liveType !== snap.proposalType) ||
          (liveCategory && snap.category && liveCategory !== snap.category) ||
          (liveText && liveText.trim() !== String(snap.ruleText).trim()) ||
          (liveTarget && snap.targetRuleId && liveTarget !== snap.targetRuleId) ||
          (liveTargetGroup && snap.targetGroup && liveTargetGroup !== snap.targetGroup)
        ) {
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
            if (!groupDef) {
              guardError = `Target group ${targetGroup} not found on disk (need ${targetGroup}-0)`;
              outcome = "rejected_by_guard";
            } else {
              const nextItem = nextFreeItemNumber(targetGroup, ...usedIds ? [[...usedIds].map((id) => ({ id }))] : []);
              const nextId = `${targetGroup}-${nextItem}`;
              const guardMsg = guardRule({
                text,
                category: isCategory(category) ? category : null,
                nextId,
                existingIds: usedIds,
              });
              if (guardMsg) {
                guardError = guardMsg;
                outcome = "rejected_by_guard";
              } else {
                const filePath = ruleFileName(nextId, category);
                const content = buildRuleFile({
                  id: nextId,
                  type: "item",
                  group: targetGroup,
                  category,
                  text,
                  status: "active",
                  source: "community",
                });
                const branch = `rule/${nextId}-from-${issue.number}`;
                const pr = await upsertFilePr({
                  owner,
                  repo,
                  branch,
                  base: "main",
                  path: filePath,
                  content,
                  title: `Rule ${nextId}: ${category} (issue #${issue.number})`,
                  body: `Ratified community proposal #${issue.number}.\n\n**type:** new\n**targetGroup:** ${targetGroup}\n**quorum:** ${quorumForVote} (starsAtVotingStart=${starsForVote}, stage=${stageInfo.stage})\n**votes:** 👍${tally.up} 👎${tally.down}\n**voteDeadline:** settle run\n**founderVote:** ${founderVote}${founderVote ? ` (F1 casting vote, starsAtVotingStart < ${FOUNDER_STAR_CEILING})` : ""}`,
                });
                prNumber = pr.number;
                prUrl = pr.html_url;
                usedIds.add(nextId);
                // Preserve pre-review snapshot; write settlement info separately
                writeDecision(`settlement-snapshot-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  category,
                  ruleText: text,
                  proposalType: "new",
                  ruleId: nextId,
                  targetGroup,
                  prNumber: pr.number,
                  branch,
                  snapshotAt: new Date().toISOString(),
                });
                await finishPr({ issue, prNumber, nextId, type: "new" });
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
            if (!existing) {
              guardError = `Target rule ${targetRuleId} not found on disk`;
              outcome = "rejected_by_guard";
            } else {
              const ruleCategory =
                pType === "revoke"
                  ? existing.category
                  : isCategory(category)
                    ? category
                    : existing.category;
              const maxChars = isGroupRule(targetRuleId) ? RULE_MAX_CHARS_GROUP : RULE_MAX_CHARS;
              if (pType === "amend") {
                if (!text || text.length < 20 || text.length > maxChars) {
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
                if (!text || text.length < 20 || text.length > RULE_MAX_CHARS) {
                  guardError = "Revoke justification length invalid";
                  outcome = "rejected_by_guard";
                } else if (scanRuleText(text)) {
                  guardError = "Revoke justification failed safety scan";
                  outcome = "rejected_by_guard";
                }
              }

              if (outcome === "ratified") {
                const today = new Date().toISOString().slice(0, 10);
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
                const pr = await upsertFilePr({
                  owner,
                  repo,
                  branch,
                  base: "main",
                  path: existing.path,
                  content,
                  title: `Rule ${targetRuleId}: ${pType} (issue #${issue.number})`,
                  body: `Ratified community proposal #${issue.number}.\n\n**type:** ${pType}\n**target:** ${targetRuleId}\n**quorum:** ${quorumForVote} (starsAtVotingStart=${starsForVote}, stage=${stageInfo.stage})\n**votes:** 👍${tally.up} 👎${tally.down}\n**voteDeadline:** settle run\n**founderVote:** ${founderVote}${founderVote ? ` (F1 casting vote, starsAtVotingStart < ${FOUNDER_STAR_CEILING})` : ""}`,
                });
                prNumber = pr.number;
                prUrl = pr.html_url;
                // Preserve pre-review snapshot; write settlement info separately
                writeDecision(`settlement-snapshot-${issue.number}-${Date.now()}.json`, {
                  issueNumber: issue.number,
                  category: ruleCategory,
                  ruleText: text,
                  proposalType: pType,
                  targetRuleId,
                  prNumber: pr.number,
                  branch,
                  snapshotAt: new Date().toISOString(),
                });
                await finishPr({
                  issue,
                  prNumber,
                  nextId: targetRuleId,
                  type: pType,
                });
              }
            }
          }
        }
      }
    }

    async function finishPr({ issue, prNumber, nextId, type }) {
      const prFull = await getPull(prNumber);
      const labels = (prFull.labels || []).map((l) => l.name);
      if (!canAutoMerge(stars)) {
        skippedMerge = true;
        await comment(
          issue.number,
          `stars ${stars} < ${AUTO_MERGE_MIN_STARS}: PR #${prNumber} opened but **not auto-merged**. A maintainer must merge to apply ${type} ${nextId}.`,
        );
      } else if (labels.includes(LABELS.doNotMerge)) {
        skippedMerge = true;
        await comment(
          issue.number,
          `Maintainer kill switch: PR #${prNumber} has \`do-not-merge\`. Not auto-merging.`,
        );
      } else {
        try {
          await mergePullRequest(prNumber);
          await comment(issue.number, `Merged PR #${prNumber} — ${type} ${nextId} applied.`);
        } catch (err) {
          skippedMerge = true;
          await comment(
            issue.number,
            `PR #${prNumber} opened but merge failed: ${String(err.message).slice(0, 200)}`,
          );
        }
      }
    }

    // Ratified only when the rule file is actually on main. Pending merge stays open.
    if (outcome === "ratified" && skippedMerge) {
      outcome = "ratified_pending_merge";
    }

    const label =
      outcome === "ratified"
        ? LABELS.ratified
        : outcome === "ratified_pending_merge"
          ? LABELS.pendingMerge
          : outcome === "defeated"
            ? LABELS.defeated
            : outcome === "expired_no_quorum"
              ? LABELS.expired
              : LABELS.rejected;

    await setLabels(
      issue.number,
      [label],
      [LABELS.voting, LABELS.proposal],
    );

    const summary = [
      `### Settlement — ${outcome}`,
      "",
      `- 👍 ${tally.up} / 👎 ${tally.down} (void ${tally.voided}, valid ${tally.valid})`,
      `- quorum (approve-count): ${quorumForVote} · starsAtVotingStart ${starsForVote} · stage ${stageInfo.stage}`,
      `- vote deadline: this settle run (reactions after are not counted)`,
      `- account age gate: ≥ ${MIN_ACCOUNT_AGE_DAYS} days · dropped young ${tally.droppedYoung ?? 0} · dropped unknown/lookup-failed ${tally.droppedUnknown ?? 0}`,
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
    await comment(issue.number, summary);
    if (outcome !== "ratified_pending_merge") {
      await closeIssue(issue.number);
    }

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
      minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
      founderVote,
      founderLogin: founderVote ? FOUNDER_LOGIN : null,
      prNumber,
      guardError,
      skippedMerge,
      settledAt: new Date().toISOString(),
    });
    results.push({
      issueNumber: issue.number,
      outcome,
      prNumber,
      founderVote,
    });
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
    // Still try per-issue getPull fallback below via snapshot prNumber when possible.
  }

  for (const issue of pending) {
    try {
      const branchRe = new RegExp(`rule/\\d+-\\d+-from-${issue.number}$`, "i");
      const snap = loadSnapshot(issue.number);
      let openPr = openPulls.find((p) => branchRe.test(p.head?.ref || ""));
      let closedPr = closedPulls.find((p) => branchRe.test(p.head?.ref || ""));

      // Fallback: snapshot records the PR number from settlement.
      if (!openPr && !closedPr && snap?.prNumber) {
        try {
          const pr = await getPull(snap.prNumber);
          if (pr.state === "open") openPr = pr;
          else closedPr = pr;
        } catch {
          /* leave unset */
        }
      }

      if (openPr) {
        if (!canAutoMerge(stars)) {
          results.push({ issueNumber: issue.number, outcome: "still_pending", prNumber: openPr.number });
          continue;
        }
        let labels = [];
        try {
          const prFull = await getPull(openPr.number);
          labels = (prFull.labels || []).map((l) => l.name);
        } catch {
          /* treat as unlabeled */
        }
        if (labels.includes(LABELS.doNotMerge)) {
          results.push({ issueNumber: issue.number, outcome: "still_pending_killswitch", prNumber: openPr.number });
          continue;
        }
        try {
          await mergePullRequest(openPr.number);
          await setLabels(issue.number, [LABELS.ratified], [LABELS.pendingMerge]);
          await comment(
            issue.number,
            `✅ PR #${openPr.number} merged on a later cycle — rule is now active. Closing.`,
          );
          await closeIssue(issue.number);
          writeDecision(`recover-${issue.number}-${Date.now()}.json`, {
            issueNumber: issue.number,
            outcome: "ratified",
            prNumber: openPr.number,
            recoveredAt: new Date().toISOString(),
          });
          results.push({ issueNumber: issue.number, outcome: "ratified", prNumber: openPr.number });
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

      if (closedPr && (await pullIsMerged(closedPr))) {
        await setLabels(issue.number, [LABELS.ratified], [LABELS.pendingMerge]);
        await comment(
          issue.number,
          `✅ PR #${closedPr.number} was merged outside the bot. Rule is active. Closing.`,
        );
        await closeIssue(issue.number);
        writeDecision(`recover-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome: "ratified",
          prNumber: closedPr.number,
          recoveredAt: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, outcome: "ratified", prNumber: closedPr.number });
        continue;
      }

      if (closedPr) {
        await setLabels(issue.number, [LABELS.rejected], [LABELS.pendingMerge]);
        await comment(
          issue.number,
          `❌ PR #${closedPr.number} was closed without merge. Rule is not active. Closing issue.`,
        );
        await closeIssue(issue.number);
        writeDecision(`recover-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          outcome: "rejected_pr_closed",
          prNumber: closedPr.number,
          recoveredAt: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, outcome: "rejected_pr_closed", prNumber: closedPr.number });
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

async function preReviewPhase({ metaRules, prompt, stars }) {
  const proposals = await listOpenIssuesWithLabel(LABELS.proposal);
  log(`pre-review: ${proposals.length} proposal(s)`);
  const results = [];
  const promptBody = loadPrompt(prompt);

  for (const issue of proposals) {
    // Structural gates before spending an LLM call
    const pType = parseProposalType(issue.body || "");
    if (!["new", "amend", "revoke"].includes(pType)) {
      await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
      await comment(
        issue.number,
        `❌ Pre-review rejected: Proposal Type must be \`new\`, \`amend\`, or \`revoke\` (got \`${pType}\`).`,
      );
      await closeIssue(issue.number);
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "reject",
        reason: `unsupported_proposal_type:${pType}`,
        matchedMetaRules: [],
        reviewedAt: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "reject" });
      continue;
    }

    const targetRuleId = parseTargetRule(issue.body || "");
    if (pType !== "new") {
      if (!targetRuleId || !/^\d+-\d+$/.test(targetRuleId)) {
        await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
        await comment(
          issue.number,
          "❌ Pre-review rejected: \u0060amend\u0060/\u0060revoke\u0060 proposals need `## Target Rule` with an id like `3-1`.",
        );
        await closeIssue(issue.number);
        writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          verdict: "reject",
          reason: "missing_target_rule",
          matchedMetaRules: ["M1"],
          reviewedAt: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, verdict: "reject" });
        continue;
      }
      const existing = findRuleFile(path.join(ROOT, "rules"), targetRuleId);
      if (!existing) {
        await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
        await comment(
          issue.number,
          `❌ Pre-review rejected: target rule \`${targetRuleId}\` not found under \`rules/\`.`,
        );
        await closeIssue(issue.number);
        writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          verdict: "reject",
          reason: `target_not_found:${targetRuleId}`,
          matchedMetaRules: [],
          reviewedAt: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, verdict: "reject" });
        continue;
      }
    }

    // new: require an existing group (MVP does not create groups)
    if (pType === "new") {
      const tg = parseTargetGroup(issue.body || "");
      if (!tg) {
        await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
        await comment(
          issue.number,
          "❌ Pre-review rejected: `new` proposals need `## Target Group` with a group number like `3` (existing group only).",
        );
        await closeIssue(issue.number);
        writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          verdict: "reject",
          reason: "missing_target_group",
          matchedMetaRules: ["M1"],
          reviewedAt: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, verdict: "reject" });
        continue;
      }
      const groupDef = findRuleFile(path.join(ROOT, "rules"), `${tg}-0`);
      if (!groupDef) {
        await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
        await comment(
          issue.number,
          `❌ Pre-review rejected: target group \`${tg}\` not found (need \`${tg}-0\`). MVP only accepts items in existing groups.`,
        );
        await closeIssue(issue.number);
        writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
          issueNumber: issue.number,
          verdict: "reject",
          reason: `target_group_not_found:${tg}`,
          matchedMetaRules: [],
          reviewedAt: new Date().toISOString(),
        });
        results.push({ issueNumber: issue.number, verdict: "reject" });
        continue;
      }
    }

    let category = parseCategory(issue.body || "");
    if (!category && pType !== "revoke") {
      await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
      await comment(
        issue.number,
        "❌ Pre-review rejected: Category must be one of `model-releases`, `research`, `industry`, `policy`, `tools-oss` (first line under ## Category).",
      );
      await closeIssue(issue.number);
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "reject",
        reason: "invalid_category",
        matchedMetaRules: [],
        reviewedAt: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "reject" });
      continue;
    }
    if (pType === "revoke" && !category) {
      const existing = findRuleFile(path.join(ROOT, "rules"), targetRuleId);
      category = existing?.category || null;
    }

    // Static jailbreak/injection scan before spending an LLM call.
    const ruleText = parseRuleText(issue.body || "");
    const unsafe = scanRuleText(ruleText);
    if (unsafe) {
      await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
      await comment(
        issue.number,
        `❌ Pre-review rejected: rule text failed static safety scan (\`${unsafe}\`). Rule bodies must be inclusion criteria, not instructions to the model.`,
      );
      await closeIssue(issue.number);
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "reject",
        reason: unsafe,
        matchedMetaRules: ["M5"],
        reviewedAt: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "reject" });
      continue;
    }

    const filled = fillTemplate(promptBody, {
      META_RULES: metaRules,
      ISSUE_BODY: (issue.body || "").slice(0, 8000),
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
    if (verdictRes.verdict === "error" || verdictRes.error === true) {
      const errReason = String(verdictRes.reason || "unknown error").slice(0, 400);
      const prev = latestPreReview(issue.number);
      // Dedupe: only comment when the previous outcome was not also an error.
      if (prev?.verdict !== "error") {
        await comment(
          issue.number,
          `⚠️ Pre-review skipped (tooling error). Proposal stays in \`proposal\` and will retry next cycle.\n\n\`${errReason}\``,
        );
      }
      writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
        issueNumber: issue.number,
        verdict: "error",
        reason: errReason,
        matchedMetaRules: [],
        reviewedAt: new Date().toISOString(),
      });
      results.push({ issueNumber: issue.number, verdict: "error" });
      continue;
    }

    const verdict = verdictRes.verdict === "pass" ? "pass" : "reject";
    const reason = String(verdictRes.reason || "").slice(0, 400);
    const matched = Array.isArray(verdictRes.matchedMetaRules)
      ? verdictRes.matchedMetaRules.filter((m) => /^M[1-7]$/.test(m))
      : [];

    if (verdict === "pass") {
      // Freeze the text the community will vote on + voting-math inputs.
      writeSnapshot(issue.number, {
        issueNumber: issue.number,
        category,
        ruleText: parseRuleText(issue.body || ""),
        proposalType: pType,
        targetRuleId: targetRuleId || null,
        targetGroup: parseTargetGroup(issue.body || "") || null,
        starsAtVotingStart: stars,
        quorumAtVotingStart: quorumForStars(stars),
        voteDeadline: "settle",
        snapshotAt: new Date().toISOString(),
      });
      await setLabels(issue.number, [LABELS.voting], [LABELS.proposal]);
      await comment(
        issue.number,
        `✅ Pre-review passed (\`${pType}\`${targetRuleId ? ` → ${targetRuleId}` : ""}). Entered this cycle's vote.\n\n**Vote deadline:** the next governance settle run (Mon 03:00 UTC) — reactions after that are not counted.\n**Quorum (frozen at voting start):** ${quorumForStars(stars)} approvals · starsAtVotingStart=${stars} · account age ≥ ${MIN_ACCOUNT_AGE_DAYS} days required.\nSettles next governance cycle.`,
      );
    } else {
      await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
      await comment(
        issue.number,
        `❌ Pre-review rejected.\n\n${reason}\n\nMatched meta-rules: ${matched.join(", ") || "n/a"}`,
      );
      await closeIssue(issue.number);
    }

    writeDecision(`pre-review-${issue.number}-${Date.now()}.json`, {
      issueNumber: issue.number,
      verdict,
      reason,
      proposalType: pType,
      targetRuleId: targetRuleId || null,
      matchedMetaRules: matched,
      reviewedAt: new Date().toISOString(),
    });
    results.push({ issueNumber: issue.number, verdict });
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
  const openPulls = await listPulls({ state: "open" }).catch((err) => {
    log("listPulls failed:", String(err.message || err));
    return [];
  });
  const branchIds = ruleIdsFromBranches(openPulls.map((p) => p.head?.ref));
  const reservedIds = new Set([...diskIds, ...branchIds]);
  log(`reserved rule ids: ${[...reservedIds].sort().join(", ") || "(none)"}`);

  // Recover pending merges first so ratified rules can activate before new settles.
  // recoverPendingPhase never throws; still guard so main always reaches settle/pre-review.
  let recovered = [];
  try {
    recovered = await recoverPendingPhase({ stars });
  } catch (err) {
    log("recover-pending crashed (continuing):", String(err.message || err));
  }
  // Settle voting, then pre-review new proposals.
  const settled = await settlePhase({ stars, stageInfo, reservedIds });
  const reviewed = await preReviewPhase({ metaRules, prompt, stars });

  const summary = {
    ranAt: new Date().toISOString(),
    stage: stageInfo,
    recovered,
    settled,
    reviewed,
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
