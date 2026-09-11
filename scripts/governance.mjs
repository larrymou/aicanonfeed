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
  mergePullRequest,
  splitSlug,
  repoSlug,
} from "../lib/github.mjs";
import { stageForStars, LABELS, CATEGORIES, RULE_MAX_CHARS } from "../lib/constants.mjs";
import { chatJSON, loadPrompt, fillTemplate } from "../lib/llm.mjs";
import { loadActiveRules, maxRuleId } from "../lib/rules.mjs";

const ROOT = process.cwd();
const decisionsDir = path.join(ROOT, "decisions", "rule-reviews");

function log(...args) {
  console.log("[governance]", ...args);
}

function writeDecision(name, payload) {
  fs.mkdirSync(decisionsDir, { recursive: true });
  const file = path.join(decisionsDir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function parseProposalType(body) {
  const m = body.match(/^\s*##\s*Proposal Type\s*\n+([\s\S]*?)(?=\n\s*##\s|\n*$)/im);
  const raw = (m?.[1] || body).toLowerCase();
  if (raw.includes("revoke")) return "revoke";
  if (raw.includes("amend")) return "amend";
  return "new";
}

function parseCategory(body) {
  const m = body.match(/^\s*##\s*Category\s*\n+([\s\S]*?)(?=\n\s*##\s|\n*$)/im);
  const raw = (m?.[1] || "").trim().toLowerCase();
  for (const c of Object.keys(CATEGORIES)) {
    if (raw.includes(c)) return c;
  }
  return null;
}

function parseRuleText(body) {
  const m = body.match(/^\s*##\s*Rule Text\s*\n+([\s\S]*)$/im);
  let text = (m?.[1] || "").trim();
  text = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  // Strip common headings accidentally included
  return text;
}

function isBot(login) {
  return /\[bot\]$/i.test(login || "");
}

function tallyVotes(issue, reactions, authorLogin) {
  const byUser = new Map();
  for (const r of reactions) {
    const login = r.user?.login;
    const content = r.content;
    if (!login || login.toLowerCase() === authorLogin?.toLowerCase()) continue;
    if (isBot(login)) continue;
    if (!byUser.has(login)) byUser.set(login, new Set());
    byUser.get(login).add(content);
  }
  let up = 0;
  let down = 0;
  let voided = 0;
  const detail = [];
  for (const [login, set] of byUser) {
    // Spec: 👍/👎 only
    const hasUp = set.has("+1");
    const hasDown = set.has("-1");
    if (hasUp && hasDown) {
      voided++;
      detail.push({ login, vote: "void" });
      continue;
    }
    if (hasUp) {
      up++;
      detail.push({ login, vote: "up" });
    } else if (hasDown) {
      down++;
      detail.push({ login, vote: "down" });
    }
  }
  const valid = up + down;
  return { up, down, voided, valid, detail };
}

function settleOutcome({ up, down, valid, quorum }) {
  if (valid < quorum) return "expired_no_quorum";
  if (up > down) return "ratified";
  return "defeated";
}

function ruleFileName(id, category) {
  return `rules/${id}-${category}.md`;
}

function buildRuleFile({ id, category, text }) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "---",
    `id: ${id}`,
    "status: active",
    "source: community",
    `category: ${category}`,
    `effective_at: ${today}`,
    "---",
    "",
    text,
    "",
  ].join("\n");
}

function guardRule({ text, category, nextId, existingIds }) {
  if (!text || text.length < 20) return "Rule text too short";
  if (text.length > RULE_MAX_CHARS) return "Rule text too long";
  if (/<script|javascript:|onerror=/i.test(text)) return "Rule text contains unsafe markup";
  if (!CATEGORIES[category]) return "Invalid category";
  if (existingIds.has(nextId)) return `Rule ID ${nextId} already exists`;
  return null;
}

async function settlePhase({ stars, stageInfo, rules }) {
  const voting = await listOpenIssuesWithLabel(LABELS.voting);
  log(`settle: ${voting.length} voting issue(s), quorum=${stageInfo.quorum}`);
  const results = [];
  const { owner, repo } = splitSlug();
  // Track IDs allocated this run so multi-ratify does not collide.
  const usedIds = new Set((rules || []).map((r) => r.id));

  for (const issue of voting) {
    const reactions = await listIssueReactions(issue.number);
    const tally = tallyVotes(issue, reactions, issue.user?.login);
    let outcome = settleOutcome({
      up: tally.up,
      down: tally.down,
      valid: tally.valid,
      quorum: stageInfo.quorum,
    });
    log(`  #${issue.number} → ${outcome} (👍${tally.up} 👎${tally.down})`);

    let prNumber = null;
    let prUrl = null;
    let skippedMerge = false;
    let guardError = null;

    if (outcome === "ratified") {
      const pType = parseProposalType(issue.body || "");
      const category = parseCategory(issue.body || "");
      const text = parseRuleText(issue.body || "");

      if (pType !== "new") {
        guardError = `MVP supports new only (got ${pType})`;
        outcome = "rejected_by_guard";
      } else {
        let nextN = maxRuleId(rules) + 1;
        let nextId = `R${nextN}`;
        while (usedIds.has(nextId)) {
          nextN += 1;
          nextId = `R${nextN}`;
        }
        const guardMsg = guardRule({
          text,
          category,
          nextId,
          existingIds: usedIds,
        });
        if (guardMsg) {
          guardError = guardMsg;
          outcome = "rejected_by_guard";
        } else {
          const filePath = ruleFileName(nextId, category);
          const content = buildRuleFile({ id: nextId, category, text });
          const branch = `rule/${nextId.toLowerCase()}-from-${issue.number}`;
          const pr = await upsertFilePr({
            owner,
            repo,
            branch,
            base: "main",
            path: filePath,
            content,
            title: `Rule ${nextId}: ${category} (issue #${issue.number})`,
            body: `Ratified community proposal #${issue.number}.\n\n**quorum:** ${stageInfo.quorum} (stars=${stars}, ${stageInfo.stage})\n**votes:** 👍${tally.up} 👎${tally.down}`,
          });
          prNumber = pr.number;
          prUrl = pr.html_url;
          usedIds.add(nextId);
          const prFull = await getPull(prNumber);
          const labels = (prFull.labels || []).map((l) => l.name);
          if (labels.includes(LABELS.doNotMerge)) {
            skippedMerge = true;
            await comment(
              issue.number,
              `Maintainer kill switch: PR #${prNumber} has \`do-not-merge\`. Not auto-merging.`,
            );
          } else {
            try {
              await mergePullRequest(prNumber);
              await comment(issue.number, `Merged PR #${prNumber} — rule ${nextId} is now active.`);
            } catch (err) {
              skippedMerge = true;
              await comment(
                issue.number,
                `PR #${prNumber} opened but merge failed: ${String(err.message).slice(0, 200)}`,
              );
            }
          }
        }
      }
    }

    const label =
      outcome === "ratified" && !guardError
        ? LABELS.ratified
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
      prUrl ? `- PR: ${prUrl}` : "",
      guardError ? `- guard: ${guardError}` : "",
      skippedMerge ? "- merge skipped (kill switch or error)" : "",
    ]
      .filter(Boolean)
      .join("\n");
    await comment(issue.number, summary);
    await closeIssue(issue.number);

    writeDecision(`settlement-${issue.number}-${Date.now()}.json`, {
      issueNumber: issue.number,
      outcome,
      votes: tally,
      stars,
      stage: stageInfo.stage,
      quorum: stageInfo.quorum,
      prNumber,
      guardError,
      settledAt: new Date().toISOString(),
    });
    results.push({ issueNumber: issue.number, outcome, prNumber });
  }
  return results;
}

async function preReviewPhase({ metaRules, prompt }) {
  const proposals = await listOpenIssuesWithLabel(LABELS.proposal);
  log(`pre-review: ${proposals.length} proposal(s)`);
  const results = [];
  const promptBody = loadPrompt(prompt);

  for (const issue of proposals) {
    const filled = fillTemplate(promptBody, {
      META_RULES: metaRules,
      ISSUE_BODY: (issue.body || "").slice(0, 8000),
    });
    const verdictRes = await chatJSON({
      system: filled,
      user: "Apply the policy above to the untrusted content already included and return JSON.",
    }).catch((err) => ({ verdict: "error", reason: String(err.message).slice(0, 300) }));

    const verdict = verdictRes.verdict === "pass" ? "pass" : "reject";
    const reason = String(verdictRes.reason || "").slice(0, 400);
    const matched = Array.isArray(verdictRes.matchedMetaRules)
      ? verdictRes.matchedMetaRules.filter((m) => /^M[1-6]$/.test(m))
      : [];

    if (verdict === "pass") {
      await setLabels(issue.number, [LABELS.voting], [LABELS.proposal]);
      await comment(
        issue.number,
        `✅ Pre-review passed. Entered this cycle's vote. Settles next governance cycle.`,
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

  // Settle first (uses freshly merged rules only after next run — fine for new-only)
  const settled = await settlePhase({ stars, stageInfo, rules });
  const reviewed = await preReviewPhase({ metaRules, prompt });

  // Combined summary commit payload for the workflow to commit if desired
  const summary = {
    ranAt: new Date().toISOString(),
    stage: stageInfo,
    settled,
    reviewed,
  };
  writeDecision(`cycle-summary-${Date.now()}.json`, summary);
  log("done", JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
