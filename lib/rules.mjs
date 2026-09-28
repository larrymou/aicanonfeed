import fs from "node:fs";
import path from "node:path";
import {
  isCategory,
  RULE_MAX_CHARS,
  RULE_MAX_CHARS_GROUP,
  FOUNDER_LOGIN,
  FOUNDER_STAR_CEILING,
  PROPOSAL_OPEN_LIMIT,
  PROPOSAL_DAILY_LIMIT,
} from "./constants.mjs";
import { scanRuleText } from "./rule-guard.mjs";
import {
  parseEvidenceContractSection,
} from "./evidence.mjs";

/** Parse simple YAML frontmatter (key: value only). */
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw.trim() };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    const rawVal = mm[2].trim();
    let val = rawVal;
    if (rawVal.startsWith('"')) {
      try {
        val = JSON.parse(rawVal);
      } catch {
        val = rawVal.replace(/^["']|["']$/g, "");
      }
    } else {
      val = rawVal.replace(/^["']|["']$/g, "");
    }
    // YAML null literals must not come back as the string "null"
    // (`if (amendedAt)` would then treat "never amended" as amended).
    if (val === "null" || val === "Null" || val === "NULL" || val === "~") {
      val = null;
    }
    data[mm[1]] = val;
  }
  return { data, body: m[2].trim() };
}

/**
 * Load active rules from rules/ directory.
 * Returns { groups, items, skipped } where groups define categories and items are rules.
 */
export function loadActiveRules(rulesDir) {
  const dir = rulesDir || path.join(process.cwd(), "rules");
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md") && /^\d+-\d+$/.test(f.replace(".md", "")))
        .sort()
    : [];
  const groups = [];
  const items = [];
  const skipped = [];
  // Two-pass: collect active groups first, then drop items whose parent group
  // is missing or not active (revoke of a group must deactivate its children).
  const parsed = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const { data, body } = parseFrontmatter(raw);
    const id = data.id;
    const status = data.status;
    const type = data.type || (String(id).endsWith("-0") ? "group" : "item");
    if (!id || !status || !body) {
      skipped.push({ file: f, reason: "missing fields or body" });
      continue;
    }
    if (status !== "active") {
      skipped.push({ file: f, reason: `status=${status}` });
      continue;
    }
    parsed.push({ f, data, body, id, status, type });
    if (type === "group") {
      groups.push({
        id,
        name: data.name || data.category || id,
        category: data.category || id,
        description: body,
        file: f,
        status,
        version: Number(data.version) || 1,
        amendedAt: data.amended_at || null,
      });
    }
  }
  const activeGroupIds = new Set(groups.map((g) => String(g.id)));
  for (const { f, data, body, id, status, type } of parsed) {
    if (type === "group") continue;
    const group = String(data.group || id.split("-")[0]);
    const groupKey = activeGroupIds.has(group) ? group : `${group}-0`;
    if (!activeGroupIds.has(group) && !activeGroupIds.has(groupKey)) {
      skipped.push({ file: f, reason: `parent_group_inactive:${group}` });
      continue;
    }
    items.push({
      id,
      group: data.group || id.split("-")[0],
      category: data.category || null,
      body,
      file: f,
      status,
      version: Number(data.version) || 1,
      amendedAt: data.amended_at || null,
      requiresEvidence: data.requires_evidence
        ? String(data.requires_evidence)
            .split(/[,\s]+/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      evidenceAny: data.evidence_any
        ? String(data.evidence_any)
            .split(";")
            .map((branch) =>
              branch
                .split(/[,\s]+/)
                .map((t) => t.trim())
                .filter(Boolean),
            )
            .filter((b) => b.length)
        : [],
    });
  }
  return { groups, items, skipped };
}

/** Active rules flattened for pipeline (items only, with category from group). */
export function loadActiveItems(rulesDir) {
  const { groups, items } = loadActiveRules(rulesDir);
  const groupMap = new Map(groups.map((g) => [String(g.id), g]));
  return items
    .map((item) => {
      const g = groupMap.get(String(item.group)) || groupMap.get(`${item.group}-0`);
      return {
        id: item.id,
        category: item.category || g?.category || "uncategorized",
        body: item.body,
        groupName: g?.name || item.group,
        version: item.version,
      };
    })
    .filter((r) => r.body);
}

/** Find any rules/*.md by id (group or item). */
export function findRuleFile(rulesDir, id) {
  const dir = rulesDir || path.join(process.cwd(), "rules");
  if (!fs.existsSync(dir) || !id) return null;
  const target = String(id);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const { data, body } = parseFrontmatter(raw);
    if (String(data.id || "") !== target) continue;
    return {
      file: f,
      path: `rules/${f}`,
      data,
      body,
      id: String(data.id),
      group: data.group || target.split("-")[0],
      category: data.category || null,
      status: data.status || null,
      type: data.type || (target.endsWith("-0") ? "group" : "item"),
    };
  }
  return null;
}

/** Strip HTML comments so template guidance does not block value parsing. */
export function stripHtmlComments(text) {
  return String(text || "").replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Text under `## <heading>` until the next `##` heading or end of body.
 * Line-based so an empty section cannot swallow the next heading.
 */
export function sectionBody(body, heading) {
  const cleaned = stripHtmlComments(body);
  const lines = cleaned.split(/\r?\n/);
  const startRe = new RegExp(`^##\\s*${heading}\\s*$`, "i");
  const start = lines.findIndex((l) => startRe.test(l.trim()));
  if (start < 0) return null;
  const out = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out.join("\n");
}

/** Proposal body → `## Target Rule` value as `x-y` or null. */
export function parseTargetRule(body) {
  const section = sectionBody(body, "Target Rule");
  if (section == null) return null;
  const m = section.match(/^\s*(\d+-\d+)\b/);
  return m ? m[1] : null;
}

/**
 * Proposal body → `new` | `amend` | `revoke`.
 * Reads only the first content line under `## Proposal Type` (exact token).
 * Free prose elsewhere must not flip the type (e.g. "do not revoke, use amend").
 */
export function parseProposalType(body) {
  const section = sectionBody(body, "Proposal Type");
  if (section == null) return "new";
  const line = section
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .find((s) => s && !s.startsWith("#"));
  if (!line) return "new";
  const token = line.replace(/[^a-z]/g, "");
  if (token === "revoke") return "revoke";
  if (token === "amend") return "amend";
  return "new";
}

/** Proposal body → `## Target Group` value as group number string or null. */
export function parseTargetGroup(body) {
  const section = sectionBody(body, "Target Group");
  if (section == null) return null;
  const m = section.match(/^\s*(\d+)\b/);
  return m ? m[1] : null;
}

/** Proposal body → known category slug under `## Category` or null. */
export function parseCategory(body) {
  const section = sectionBody(body, "Category");
  if (section == null) return null;
  const line = section
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("#"));
  if (!line) return null;
  const token = line.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean)[0];
  return isCategory(token) ? token : null;
}

/** Proposal body → rule text under `## Rule Text` (comments stripped). */
export function parseRuleText(body) {
  const section = sectionBody(body, "Rule Text");
  return (section || "").trim();
}

/**
 * Hard pre-review gates shared by governance and tests (no LLM).
 * Returns `{ ok: true, fields }` or `{ ok: false, code, reason, message, matchedMetaRules }`.
 * `rulesDir` enables on-disk target existence checks; omit to validate shape only.
 */
export function evaluateProposalBody(body, { rulesDir } = {}) {
  const proposalType = parseProposalType(body);
  const category = parseCategory(body);
  const targetRuleId = parseTargetRule(body);
  const targetGroup = parseTargetGroup(body);
  const ruleText = parseRuleText(body);
  const evidenceContract = parseEvidenceContractSection(body);

  if (evidenceContract.invalidTokens?.length || evidenceContract.unknownKeys?.length || evidenceContract.duplicateKeys?.length) {
    const problems = evidenceContract.errors?.length
      ? evidenceContract.errors.join(", ")
      : (evidenceContract.invalidTokens || []).join(", ");
    return {
      ok: false,
      code: "invalid_evidence_contract",
      reason: `invalid_evidence_contract:${problems}`,
      message: `❌ Pre-review rejected: Evidence Contract has errors (\`${problems}\`). Use only ` + "`requires_evidence` / `evidence_any`" + ` with whitelist tokens.`,
      matchedMetaRules: ["M1"],
    };
  }

  if (proposalType !== "new") {
    if (!targetRuleId || !/^\d+-\d+$/.test(targetRuleId)) {
      return {
        ok: false,
        code: "missing_target_rule",
        reason: "missing_target_rule",
        message:
          "❌ Pre-review rejected: `amend`/`revoke` proposals need `## Target Rule` with an id like `3-1`.",
        matchedMetaRules: ["M1"],
      };
    }
    if (rulesDir) {
      const targetFile = findRuleFile(rulesDir, targetRuleId);
      if (!targetFile) {
        return {
          ok: false,
          code: "target_not_found",
          reason: `target_not_found:${targetRuleId}`,
          message: `❌ Pre-review rejected: target rule \`${targetRuleId}\` not found under \`rules/\`.`,
          matchedMetaRules: [],
        };
      }

      if (targetFile.data?.status === "revoked") {
        return {
          ok: false,
          code: "target_is_revoked",
          reason: `target_is_revoked:${targetRuleId}`,
          message: `❌ Pre-review rejected: target rule \`${targetRuleId}\` is already revoked. Revoked rules cannot be amended or revoked again.`,
          matchedMetaRules: [],
        };
      }
      // Settle applies these gates to amend AND revoke — pre-review must match
      // so a proposal is not burned through a vote only to die as rejected_by_guard.
      if (targetFile.status !== "active") {
        return {
          ok: false,
          code: "target_not_active",
          reason: `target_not_active:${targetRuleId}:${targetFile.status || "missing"}`,
          message: `❌ Pre-review rejected: target rule \`${targetRuleId}\` is not active.`,
          matchedMetaRules: ["M1"],
        };
      }
      if (targetFile.type !== "group") {
        const groupId = String(targetFile.group || targetRuleId.split("-")[0]);
        const parentId = groupId.endsWith("-0") ? groupId : `${groupId}-0`;
        const parent = findRuleFile(rulesDir, parentId);
        if (!parent || parent.type !== "group" || parent.status !== "active") {
          return {
            ok: false,
            code: "target_group_inactive",
            reason: `target_group_inactive:${parentId}:${parent?.status || "missing"}`,
            message: `❌ Pre-review rejected: target rule \`${targetRuleId}\` belongs to a group that is not active.`,
            matchedMetaRules: ["M1"],
          };
        }
      }
    }
  }

  if (proposalType === "new") {
    if (!targetGroup || !/^\d+$/.test(targetGroup)) {
      return {
        ok: false,
        code: "missing_target_group",
        reason: "missing_target_group",
        message:
          "❌ Pre-review rejected: `new` proposals need `## Target Group` with a group number like `3` (existing group only).",
        matchedMetaRules: ["M1"],
      };
    }
    if (rulesDir && !findRuleFile(rulesDir, `${targetGroup}-0`)) {
      return {
        ok: false,
        code: "target_group_not_found",
        reason: `target_group_not_found:${targetGroup}`,
        message: `❌ Pre-review rejected: target group \`${targetGroup}\` not found (need \`${targetGroup}-0\`). MVP only accepts items in existing groups.`,
        matchedMetaRules: [],
      };
    }
    const groupFile = rulesDir ? findRuleFile(rulesDir, `${targetGroup}-0`) : null;
    if (
      rulesDir &&
      (!groupFile || groupFile.type !== "group" || groupFile.status !== "active")
    ) {
      return {
        ok: false,
        code: "target_group_inactive",
        reason: `target_group_inactive:${targetGroup}:${groupFile?.status || "missing"}`,
        message: `❌ Pre-review rejected: target group \`${targetGroup}\` is not active. Choose an active group.`,
        matchedMetaRules: ["M1"],
      };
    }
  }

  let resolvedCategory = category;
  if (!category && proposalType !== "revoke") {
    return {
      ok: false,
      code: "invalid_category",
      reason: "invalid_category",
      message:
        "❌ Pre-review rejected: Category must be one of `model-releases`, `research`, `industry`, `policy`, `tools-oss` (first line under ## Category).",
      matchedMetaRules: [],
    };
  }
  if (proposalType === "revoke" && !category && rulesDir && targetRuleId) {
    resolvedCategory = findRuleFile(rulesDir, targetRuleId)?.category || null;
  }

  // Group and category must agree — the model sees group context, the feed publishes category.
  if (rulesDir && proposalType === "new" && targetGroup) {
    const groupDef = findRuleFile(rulesDir, `${targetGroup}-0`);
    const groupCat = groupDef?.category || null;
    if (groupCat && resolvedCategory && resolvedCategory !== groupCat) {
      return {
        ok: false,
        code: "category_group_mismatch",
        reason: `category_group_mismatch:${resolvedCategory}!=${groupCat}`,
        message: `❌ Pre-review rejected: Category \`${resolvedCategory}\` does not match target group \`${targetGroup}\` (expected \`${groupCat}\`).`,
        matchedMetaRules: ["M1"],
      };
    }
  }
  if (rulesDir && proposalType === "amend" && targetRuleId) {
    const existing = findRuleFile(rulesDir, targetRuleId);
    const groupCat =
      existing?.category ||
      findRuleFile(rulesDir, `${String(targetRuleId).split("-")[0]}-0`)?.category ||
      null;
    if (groupCat && resolvedCategory && resolvedCategory !== groupCat) {
      return {
        ok: false,
        code: "category_group_mismatch",
        reason: `category_group_mismatch:${resolvedCategory}!=${groupCat}`,
        message: `❌ Pre-review rejected: Category \`${resolvedCategory}\` does not match target rule group (expected \`${groupCat}\`).`,
        matchedMetaRules: ["M1"],
      };
    }
  }

  const unsafe = scanRuleText(ruleText);
  if (unsafe) {
    return {
      ok: false,
      code: "rule_text_unsafe",
      reason: unsafe,
      message: `❌ Pre-review rejected: rule text failed static safety scan (\`${unsafe}\`). Rule bodies must be inclusion criteria, not instructions to the model.`,
      matchedMetaRules: ["M5"],
    };
  }

  // Length limits (same contract settlement uses via maxRuleChars).
  const maxChars = maxRuleChars(
    targetRuleId || (proposalType === "new" && targetGroup ? `${targetGroup}-1` : "1-1"),
  );
  const textLen = String(ruleText || "").trim().length;
  // Same minimum for every proposal type (including revoke justification) so
  // settlement cannot reject a proposal that pre-review already passed.
  if (textLen < 20) {
    return {
      ok: false,
      code: "rule_text_too_short",
      reason: "rule_text_too_short",
      message:
        "❌ Pre-review rejected: Rule Text must be at least 20 characters (actionable inclusion criteria; for `revoke`, a public justification).",
      matchedMetaRules: ["M2"],
    };
  }
  if (textLen > maxChars) {
    return {
      ok: false,
      code: "rule_text_too_long",
      reason: `rule_text_too_long:${textLen}>${maxChars}`,
      message: `❌ Pre-review rejected: Rule Text is ${textLen} chars (max ${maxChars}).`,
      matchedMetaRules: ["M1"],
    };
  }

  // Fail-closed: every new rule must declare how evidence is satisfied.
  // Platform does NOT judge whether a contract is currently observable —
  // page-fact-only contracts are a legitimate legislative choice (e.g. a
  // future evidence fetcher). The evidence engine enforces what was ratified.
  if (proposalType === "new" && evidenceContract.empty) {
    return {
      ok: false,
      code: "missing_evidence_contract",
      reason: "missing_evidence_contract",
      message:
        "❌ Pre-review rejected: `new` proposals need `## Evidence Contract` with `requires_evidence` and/or `evidence_any` (tokens from the whitelist). An empty contract would disable the evidence hard gate.",
      matchedMetaRules: ["M1"],
    };
  }

  return {
    ok: true,
    fields: {
      proposalType,
      category: resolvedCategory,
      targetRuleId: targetRuleId || null,
      targetGroup: targetGroup || null,
      ruleText,
      evidenceContract: {
        requiresEvidence: evidenceContract.requiresEvidence,
        evidenceAny: evidenceContract.evidenceAny,
        // amend/revoke may omit (inherit); new is already fail-closed above
        declared: !evidenceContract.empty,
      },
    },
  };
}

/** Max rule-text length for a target id (group defs are shorter). */
export function maxRuleChars(targetRuleId) {
  return String(targetRuleId || "").endsWith("-0")
    ? RULE_MAX_CHARS_GROUP
    : RULE_MAX_CHARS;
}

/** Founder filing quota is unlimited while stars < F1 ceiling (same star gate as F1). */
export function isProposalQuotaExempt({
  login,
  stars = 0,
  founderLogin = FOUNDER_LOGIN,
  founderStarCeiling = FOUNDER_STAR_CEILING,
}) {
  const f = String(founderLogin || "").toLowerCase();
  if (!f) return false;
  const n = Math.max(0, Number(stars) || 0);
  return String(login || "").toLowerCase() === f && n < founderStarCeiling;
}

function sortProposalsByAge(list) {
  return [...list].sort((a, b) => {
    const rawA = Date.parse(a.createdAt || "");
    const rawB = Date.parse(b.createdAt || "");
    const ta = Number.isFinite(rawA) ? rawA : 0;
    const tb = Number.isFinite(rawB) ? rawB : 0;
    if (ta !== tb) return ta - tb;
    return (Number(a.number) || 0) - (Number(b.number) || 0);
  });
}

/**
 * Proposal filing quota (no LLM). Non-exempt authors: at most PROPOSAL_OPEN_LIMIT open
 * proposals (oldest kept) and PROPOSAL_DAILY_LIMIT new ones per UTC day.
 * `openByAuthor` / `createdTodayByAuthor` are `[{ number, createdAt }]` including the current issue.
 * Returns `{ ok: true, exempt }` or `{ ok: false, code, reason, message }`.
 */
export function evaluateProposalQuota({
  login,
  stars = 0,
  issueNumber,
  openByAuthor = [],
  createdTodayByAuthor = [],
  founderLogin = FOUNDER_LOGIN,
  founderStarCeiling = FOUNDER_STAR_CEILING,
}) {
  if (isProposalQuotaExempt({ login, stars, founderLogin, founderStarCeiling })) {
    return { ok: true, exempt: true };
  }

  const openLimitMsg = `❌ Pre-review rejected: at most ${PROPOSAL_OPEN_LIMIT} open rule proposal per author. Close or wait for your current proposal before filing another.`;
  const dailyLimitMsg = `❌ Pre-review rejected: at most ${PROPOSAL_DAILY_LIMIT} new rule proposal per UTC day per author. Try again tomorrow.`;

  const openSorted = sortProposalsByAge(openByAuthor);
  const openRank = openSorted.findIndex((p) => Number(p.number) === Number(issueNumber));
  const isOldestOpen = openRank === 0;
  // Current must be present; if omitted while the author already has an open proposal, fail closed.
  if (
    openSorted.length > PROPOSAL_OPEN_LIMIT ||
    (openRank === -1 && openSorted.length >= PROPOSAL_OPEN_LIMIT)
  ) {
    if (!isOldestOpen) {
      return {
        ok: false,
        code: "open_limit",
        reason: "proposal_quota:open_limit",
        message: openLimitMsg,
      };
    }
  }

  const todaySorted = sortProposalsByAge(createdTodayByAuthor);
  const todayRank = todaySorted.findIndex((p) => Number(p.number) === Number(issueNumber));
  const isFirstToday = todayRank === 0;
  if (
    todaySorted.length > PROPOSAL_DAILY_LIMIT ||
    (todayRank === -1 && todaySorted.length >= PROPOSAL_DAILY_LIMIT)
  ) {
    if (!isFirstToday) {
      return {
        ok: false,
        code: "daily_limit",
        reason: "proposal_quota:daily_limit",
        message: dailyLimitMsg,
      };
    }
  }

  return { ok: true, exempt: false };
}

/** Start of the current UTC day as ISO timestamp. */
export function startOfUtcDay(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Exclusive end of the UTC day containing `now` (start of the next day). */
export function endOfUtcDay(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/**
 * Rows whose created_at falls on the same UTC day as `anchorCreatedAt` —
 * the proposal under review, not the process run date. Accepts `created_at`
 * (GitHub) or `createdAt` (quota rows).
 */
export function filterCreatedOnUtcDay(rows, anchorCreatedAt, { now = Date.now() } = {}) {
  const anchorMs = Date.parse(String(anchorCreatedAt || ""));
  const anchor = Number.isFinite(anchorMs) ? anchorMs : now;
  const dayStartMs = Date.parse(startOfUtcDay(anchor));
  const dayEndMs = Date.parse(endOfUtcDay(anchor));
  return (rows || []).filter((row) => {
    const createdMs = Date.parse(String(row?.created_at || row?.createdAt || ""));
    if (!Number.isFinite(createdMs)) return false;
    return createdMs >= dayStartMs && createdMs < dayEndMs;
  });
}

export function buildRuleFile({
  id,
  type = "item",
  group = null,
  category,
  name = null,
  text,
  status = "active",
  source = "community",
  version = 1,
  amendedAt = null,
  revokedAt = null,
  effectiveAt = null,
  revokedReason = null,
  requiresEvidence = [],
  evidenceAny = [],
}) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "---",
    `id: ${id}`,
    `type: ${type}`,
  ];
  if (group) lines.push(`group: ${group}`);
  lines.push(
    `status: ${status}`,
    `source: ${source}`,
    `category: ${category}`,
  );
  if (name) lines.push(`name: ${JSON.stringify(String(name))}`);
  lines.push(
    `effective_at: ${effectiveAt || today}`,
    `amended_at: ${amendedAt || "null"}`,
    `version: ${version}`,
  );
  const req = (requiresEvidence || []).map((t) => String(t).trim()).filter(Boolean);
  if (req.length) {
    lines.push(`requires_evidence: ${req.join(", ")}`);
  }
  const any = (evidenceAny || [])
    .map((branch) =>
      (Array.isArray(branch) ? branch : String(branch).split(/[,\s]+/))
        .map((t) => String(t).trim())
        .filter(Boolean)
        .join(","),
    )
    .filter(Boolean);
  if (any.length) {
    lines.push(`evidence_any: ${any.join("; ")}`);
  }
  if (revokedAt) lines.push(`revoked_at: ${revokedAt}`);
  if (revokedReason) {
    // Single-line frontmatter value; flatten whitespace and quote so `:` / `"`
    // in the community justification cannot break the simple parser.
    const reason = String(revokedReason).replace(/\s+/g, " ").trim();
    lines.push(`revoked_reason: ${JSON.stringify(reason)}`);
  }
  lines.push("---", "", text.trim(), "");
  return lines.join("\n");
}

/** Parse evidence metadata from a findRuleFile() record (for amend/revoke preserve). */
export function evidenceMetaFromRuleFile(existing) {
  const data = existing?.data || {};
  const requiresEvidence = data.requires_evidence
    ? String(data.requires_evidence)
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const evidenceAny = data.evidence_any
    ? String(data.evidence_any)
        .split(";")
        .map((branch) =>
          branch
            .split(/[,\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        )
        .filter((b) => b.length)
    : [];
  return { requiresEvidence, evidenceAny };
}

export function maxGroupId(groups) {
  let max = 0;
  for (const g of groups) {
    const p = String(g.id || "").split("-");
    if (p.length === 2) max = Math.max(max, Number(p[0]));
  }
  return max;
}

/** Next free group number: max existing group + 1. */
export function nextFreeGroupNumber(...groupSets) {
  let max = 0;
  for (const set of groupSets) {
    for (const g of set || []) {
      const p = String(g.id || g).split("-");
      if (p.length === 2) max = Math.max(max, Number(p[0]));
    }
  }
  return max + 1;
}

/** Next free item number within a group: max existing item + 1 (never reuse). */
export function nextFreeItemNumber(groupId, ...itemSets) {
  let max = 0;
  for (const set of itemSets) {
    for (const item of set || []) {
      const id = String(item.id || item);
      const p = id.split("-");
      if (p.length === 2 && p[0] === String(groupId) && Number(p[1]) > 0) {
        max = Math.max(max, Number(p[1]));
      }
    }
  }
  return max + 1;
}

/** All rule ids on disk (any status) so deleted slots are never reused. */
export function reservedRuleIds(rulesDir) {
  const dir = rulesDir || path.join(process.cwd(), "rules");
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const base = f.replace(".md", "");
    if (/^\d+-\d+$/.test(base)) ids.add(base);
  }
  return ids;
}

/** Ids implied by open bot PR branch names: rule/1-1-from-123 */
export function ruleIdsFromBranches(branches) {
  const ids = new Set();
  for (const branch of branches || []) {
    const m = /rule\/(\d+-\d+)-from-/i.exec(String(branch || ""));
    if (m) ids.add(m[1]);
  }
  return ids;
}

export function rulesForPrompt(groups, items) {
  const groupMap = new Map(groups.map((g) => [String(g.id), g]));
  const byGroup = new Map();
  for (const item of items) {
    const gid = String(item.group);
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(item);
  }
  const lines = [];
  for (const g of groups.sort((a, b) => Number(String(a.id).split("-")[0]) - Number(String(b.id).split("-")[0]))) {
    const gid = String(g.id).split("-")[0];
    lines.push(`### Group ${gid}: ${g.name} (${g.category})`);
    const groupItems = byGroup.get(gid) || [];
    for (const item of groupItems) {
      let contractStr = "";
      const reqStr = (item.requiresEvidence || []).join(", ");
      if (reqStr) contractStr += ` [Requires Evidence: ${reqStr}]`;
      const anyStrs = (item.evidenceAny || []).map((b) => b.join(" + ")).join(" OR ");
      if (anyStrs) contractStr += ` [Requires Evidence (Any): ${anyStrs}]`;
      lines.push(`- ${item.id}: ${item.body.replace(/\s+/g, " ")}${contractStr}`);
    }
  }
  return lines.join("\n");
}
