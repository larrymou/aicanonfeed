#!/usr/bin/env node
/**
 * Governance cycle: settle previous voting batch, then pre-review new proposals.
 * MVP: proposal type "new" only.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getRepo,
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
import { stageForStars, LABELS, RULE_MAX_CHARS, isCategory, FOUNDER_LOGIN, FOUNDER_STAR_CEILING } from "../lib/constants.mjs";
import { tallyVotes, settleOutcome, applyFounderVote } from "../lib/voting.mjs";
import { chatJSON, loadPrompt, fillTemplate } from "../lib/llm.mjs";
import {
  loadActiveRules,
  reservedRuleIds,
  ruleIdsFromBranches,
  nextFreeRuleId,
  findRuleFile,
  parseTargetRule,
  buildRuleFile,
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

function parseProposalType(body) {
  const m = body.match(/^\s*##\s*Proposal Type\s*\n+([\s\S]*?)(?=\n\s*##\s|\n*$)/im);
  // Missing section → treat as new (template requires it; avoid full-body keyword false positives).
  if (!m) return "new";
  const raw = m[1].toLowerCase();
  if (raw.includes("revoke")) return "revoke";
  if (raw.includes("amend")) return "amend";
  return "new";
}

function parseCategory(body) {
  const m = body.match(/^\s*##\s*Category\s*\n+([\s\S]*?)(?=\n\s*##\s|\n*$)/im);
  if (!m) return null;
  // First non-empty, non-comment line only — exact slug match
  const line = m[1]
    .split(/\r?\n/)
    .map((s) => s.replace(/<!--[\s\S]*?-->/g, "").trim())
    .find((s) => s && !s.startsWith("#"));
  if (!line) return null;
  const token = line.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean)[0];
  return isCategory(token) ? token : null;
}

function parseRuleText(body) {
  const m = body.match(/^\s*##\s*Rule Text\s*\n+([\s\S]*)$/im);
  let text = (m?.[1] || "").trim();
  text = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  // Strip common headings accidentally included
  return text;
}

function ruleFileName(id, category) {
  return `rules/${id}-${category}.md`;
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

async function settlePhase({ stars, stageInfo, reservedIds }) {
  const voting = await listOpenIssuesWithLabel(LABELS.voting);
  log(`settle: ${voting.length} voting issue(s), quorum=${stageInfo.quorum}`);
  const results = [];
  const { owner, repo } = splitSlug();
  // Include on-disk ids and open-PR branch ids so pending rules cannot be reallocated.
  const usedIds = new Set(reservedIds);

  for (const issue of voting) {
    const reactions = await listIssueReactions(issue.number);
    const tally = tallyVotes(reactions, issue.user?.login);
    const { founderVote } = applyFounderVote({
      stars,
      reactions,
      founderLogin: FOUNDER_LOGIN,
      ceiling: FOUNDER_STAR_CEILING,
    });
    let outcome = settleOutcome({
      up: tally.up,
      down: tally.down,
      valid: tally.valid,
      quorum: stageInfo.quorum,
      founderVote,
    });
    log(
      `  #${issue.number} → ${outcome} (👍${tally.up} 👎${tally.down}${founderVote ? " founderVote" : ""})`,
    );

    let prNumber = null;
    let prUrl = null;
    let skippedMerge = false;
    let guardError = null;

    if (outcome === "ratified") {
      const snap = loadSnapshot(issue.number);
      const pType = snap?.proposalType || parseProposalType(issue.body || "");
      let category = parseCategory(issue.body || "");
      let text = parseRuleText(issue.body || "");
      let targetRuleId = snap?.targetRuleId || parseTargetRule(issue.body || "");

      // Prefer the pre-review snapshot so post-vote body edits cannot change the rule.
      if (snap?.ruleText) {
        const liveCategory = parseCategory(issue.body || "");
        const liveText = parseRuleText(issue.body || "");
        const liveTarget = parseTargetRule(issue.body || "");
        if (
          (liveCategory && snap.category && liveCategory !== snap.category) ||
          (liveText && liveText.trim() !== String(snap.ruleText).trim()) ||
          (liveTarget && snap.targetRuleId && liveTarget !== snap.targetRuleId)
        ) {
          guardError = "Issue body changed after pre-review snapshot";
          outcome = "rejected_by_guard";
        } else if (snap.category || snap.ruleText) {
          category = snap.category || category;
          text = snap.ruleText || text;
          targetRuleId = snap.targetRuleId || targetRuleId;
        }
      }

      if (outcome === "ratified" && !["new", "amend", "revoke"].includes(pType)) {
        guardError = `Unsupported proposal type (${pType})`;
        outcome = "rejected_by_guard";
      } else if (outcome === "ratified") {
        if (pType === "new") {
          const nextId = nextFreeRuleId(usedIds);
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
              category,
              text,
              status: "active",
              source: "community",
            });
            const branch = `rule/${nextId.toLowerCase()}-from-${issue.number}`;
            const pr = await upsertFilePr({
              owner,
              repo,
              branch,
              base: "main",
              path: filePath,
              content,
              title: `Rule ${nextId}: ${category} (issue #${issue.number})`,
              body: `Ratified community proposal #${issue.number}.\n\n**type:** new\n**quorum:** ${stageInfo.quorum} (stars=${stars}, ${stageInfo.stage})\n**votes:** 👍${tally.up} 👎${tally.down}\n**founderVote:** ${founderVote}${founderVote ? ` (F1 casting vote, stars < ${FOUNDER_STAR_CEILING})` : ""}`,
            });
            prNumber = pr.number;
            prUrl = pr.html_url;
            usedIds.add(nextId);
            writeSnapshot(issue.number, {
              issueNumber: issue.number,
              category,
              ruleText: text,
              proposalType: "new",
              ruleId: nextId,
              prNumber: pr.number,
              branch,
              snapshotAt: new Date().toISOString(),
            });
            await finishPr({ issue, prNumber, nextId, type: "new" });
          }
        } else {
          // amend | revoke — same R# file path on disk
          if (!targetRuleId || !/^R\d+$/.test(targetRuleId)) {
            guardError = "Missing or invalid ## Target Rule (e.g. R3)";
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
              if (pType === "amend") {
                if (!text || text.length < 20 || text.length > RULE_MAX_CHARS) {
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
                // revoke: Rule Text is the public justification
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
                const content =
                  pType === "amend"
                    ? buildRuleFile({
                        id: targetRuleId,
                        category: ruleCategory,
                        text,
                        status: "active",
                        source: "community",
                      })
                    : buildRuleFile({
                        id: targetRuleId,
                        category: ruleCategory,
                        text,
                        status: "revoked",
                        source: "community-revoke",
                        revokedAt: today,
                      });
                const n = targetRuleId.replace(/^R/i, "");
                const branch = `rule/r${n}-from-${issue.number}`;
                const pr = await upsertFilePr({
                  owner,
                  repo,
                  branch,
                  base: "main",
                  path: existing.path,
                  content,
                  title: `Rule ${targetRuleId}: ${pType} (issue #${issue.number})`,
                  body: `Ratified community proposal #${issue.number}.\n\n**type:** ${pType}\n**target:** ${targetRuleId}\n**quorum:** ${stageInfo.quorum} (stars=${stars}, ${stageInfo.stage})\n**votes:** 👍${tally.up} 👎${tally.down}\n**founderVote:** ${founderVote}${founderVote ? ` (F1 casting vote, stars < ${FOUNDER_STAR_CEILING})` : ""}`,
                });
                prNumber = pr.number;
                prUrl = pr.html_url;
                writeSnapshot(issue.number, {
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
      if (stageInfo.stage === "S0") {
        skippedMerge = true;
        await comment(
          issue.number,
          `S0 safety: PR #${prNumber} opened but **not auto-merged**. A maintainer must merge to apply ${type} ${nextId}.`,
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
      `- valid votes: ${tally.valid} (quorum ${stageInfo.quorum}, stage ${stageInfo.stage}, stars ${stars})`,
      `- 👍 ${tally.up} / 👎 ${tally.down} (void ${tally.voided})`,
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
      stars,
      stage: stageInfo.stage,
      quorum: stageInfo.quorum,
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
async function recoverPendingPhase({ stageInfo }) {
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
      const branchRe = new RegExp(`rule/r\\d+-from-${issue.number}$`, "i");
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
        if (stageInfo.stage === "S0") {
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

async function preReviewPhase({ metaRules, prompt }) {
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
      if (!targetRuleId || !/^R\d+$/.test(targetRuleId)) {
        await setLabels(issue.number, [LABELS.rejected], [LABELS.proposal]);
        await comment(
          issue.number,
          "❌ Pre-review rejected: \u0060amend\u0060/\u0060revoke\u0060 proposals need `## Target Rule` with an id like `R3`.",
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
      // Freeze the text the community will vote on.
      writeSnapshot(issue.number, {
        issueNumber: issue.number,
        category,
        ruleText: parseRuleText(issue.body || ""),
        proposalType: pType,
        targetRuleId: targetRuleId || null,
        snapshotAt: new Date().toISOString(),
      });
      await setLabels(issue.number, [LABELS.voting], [LABELS.proposal]);
      await comment(
        issue.number,
        `✅ Pre-review passed (\`${pType}\`${targetRuleId ? ` → ${targetRuleId}` : ""}). Entered this cycle's vote. Settles next governance cycle.`,
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

  const { active: rules, skipped } = loadActiveRules(path.join(ROOT, "rules"));
  log(`active rules: ${rules.map((r) => r.id).join(", ") || "(none)"}`);
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
    recovered = await recoverPendingPhase({ stageInfo });
  } catch (err) {
    log("recover-pending crashed (continuing):", String(err.message || err));
  }
  // Settle voting, then pre-review new proposals.
  const settled = await settlePhase({ stars, stageInfo, reservedIds });
  const reviewed = await preReviewPhase({ metaRules, prompt });

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
