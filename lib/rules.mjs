import fs from "node:fs";
import path from "node:path";
import { CATEGORIES } from "./constants.mjs";

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

export function loadActiveRules(rulesDir) {
  const dir = rulesDir || path.join(process.cwd(), "rules");
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
  const active = [];
  const skipped = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const { data, body } = parseFrontmatter(raw);
    const id = data.id;
    const status = data.status;
    const category = data.category;
    if (!id || !status || !body) {
      skipped.push({ file: f, reason: "missing fields or body" });
      continue;
    }
    if (status !== "active") {
      skipped.push({ file: f, reason: `status=${status}` });
      continue;
    }
    if (!CATEGORIES[category]) {
      skipped.push({ file: f, reason: `unknown category ${category}` });
      continue;
    }
    active.push({ id, category, body, file: f, status });
  }
  if (files.length > 0 && active.length === 0) {
    throw new Error("No active rules parsed successfully");
  }
  return { active, skipped };
}

export function maxRuleId(rules) {
  let max = 0;
  for (const r of rules) {
    const m = /^R(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Collect rule ids already claimed on disk (any status) so pending PRs
 * and inactive files still reserve their numeric slot.
 */
export function reservedRuleIds(rulesDir) {
  const dir = rulesDir || path.join(process.cwd(), "rules");
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const m = /^R(\d+)-/.exec(f) || /^R(\d+)\./.exec(f);
    if (m) ids.add(`R${Number(m[1])}`);
  }
  return ids;
}

/** Ids implied by open bot PR branch names: rule/r6-from-123 */
export function ruleIdsFromBranches(branches) {
  const ids = new Set();
  for (const branch of branches || []) {
    const m = /rule\/r(\d+)-from-/i.exec(String(branch || ""));
    if (m) ids.add(`R${Number(m[1])}`);
  }
  return ids;
}

/** Next free R{n} given a set of already-reserved ids. */
export function nextFreeRuleId(...idSets) {
  let max = 0;
  for (const set of idSets) {
    for (const id of set || []) {
      const m = /^R(\d+)$/.exec(id);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `R${max + 1}`;
}

export function rulesForPrompt(rules) {
  return rules
    .map((r) => `- ${r.id} [${r.category}]: ${r.body.replace(/\s+/g, " ")}`)
    .join("\n");
}
