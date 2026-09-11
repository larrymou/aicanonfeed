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

export function rulesForPrompt(rules) {
  return rules
    .map((r) => `- ${r.id} [${r.category}]: ${r.body.replace(/\s+/g, " ")}`)
    .join("\n");
}
