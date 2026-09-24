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

/** Parse simple YAML frontmatter (key: value only). */
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw.trim() };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    data[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, "");
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
    } else {
      items.push({
        id,
        group: data.group || id.split("-")[0],
        category: data.category || null,
        body,
        file: f,
        status,
        version: Number(data.version) || 1,
        amendedAt: data.amended_at || null,
      });
    }
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
 * Avoids the `m`-flag `$`, which matches every line end and truncates sections.
 */
export function sectionBody(body, heading) {
  const cleaned = stripHtmlComments(body);
  const re = new RegExp(
    `(?:^|\\n)##\\s*${heading}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
  const m = cleaned.match(re);
  return m ? m[1] : null;
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
    if (rulesDir && !findRuleFile(rulesDir, targetRuleId)) {
      return {
        ok: false,
        code: "target_not_found",
        reason: `target_not_found:${targetRuleId}`,
        message: `❌ Pre-review rejected: target rule \`${targetRuleId}\` not found under \`rules/\`.`,
        matchedMetaRules: [],
      };
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

  return {
    ok: true,
    fields: {
      proposalType,
      category: resolvedCategory,
      targetRuleId: targetRuleId || null,
      targetGroup: targetGroup || null,
      ruleText,
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
  if (name) lines.push(`name: ${name}`);
  lines.push(
    `effective_at: ${effectiveAt || today}`,
    `amended_at: ${amendedAt || "null"}`,
    `version: ${version}`,
  );
  if (revokedAt) lines.push(`revoked_at: ${revokedAt}`);
  if (revokedReason) {
    // Single-line frontmatter value; flatten whitespace for the simple parser.
    const reason = String(revokedReason).replace(/\s+/g, " ").trim();
    lines.push(`revoked_reason: ${reason}`);
  }
  lines.push("---", "", text.trim(), "");
  return lines.join("\n");
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
      lines.push(`- ${item.id}: ${item.body.replace(/\s+/g, " ")}`);
    }
  }
  return lines.join("\n");
}
