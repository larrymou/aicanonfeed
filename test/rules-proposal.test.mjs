import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findRuleFile,
  parseTargetRule,
  parseTargetGroup,
  parseCategory,
  parseRuleText,
  buildRuleFile,
  parseFrontmatter,
  loadActiveRules,
  loadActiveItems,
  nextFreeItemNumber,
  nextFreeGroupNumber,
} from "../lib/rules.mjs";

function tmpRules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicanon-rules-"));
  fs.writeFileSync(
    path.join(dir, "1-0.md"),
    ["---", "id: 1-0", "type: group", "status: active", "source: seed", "category: model-releases", "name: Model Releases", "effective_at: 2026-09-14", "amended_at: null", "version: 1", "---", "", "Model releases group."].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "1-1.md"),
    ["---", "id: 1-1", "type: item", "group: 1", "status: active", "source: seed", "category: model-releases", "effective_at: 2026-09-14", "amended_at: null", "version: 1", "---", "", "Include official model launches."].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "3-0.md"),
    ["---", "id: 3-0", "type: group", "status: active", "source: seed", "category: industry", "name: Industry", "effective_at: 2026-09-14", "amended_at: null", "version: 1", "---", "", "Industry group."].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "3-1.md"),
    ["---", "id: 3-1", "type: item", "group: 3", "status: active", "source: seed", "category: industry", "effective_at: 2026-09-14", "amended_at: null", "version: 1", "---", "", "Industry business events."].join("\n"),
  );
  return dir;
}

test("parseTargetRule reads ## Target Rule x-y line", () => {
  assert.equal(parseTargetRule("## Target Rule\n\n3-1\n"), "3-1");
  assert.equal(parseTargetRule("## Proposal Type\n\namend\n\n## Target Rule\n1-0"), "1-0");
  assert.equal(parseTargetRule("no target"), null);
  // Template HTML comments before the value must not hide it
  assert.equal(
    parseTargetRule(
      "## Target Rule\n\n<!-- Existing rule id to replace. Format: group-item (e.g., 3-1). -->\n1-1\n",
    ),
    "1-1",
  );
});

test("parseCategory accepts template comments before the slug", () => {
  const body = [
    "## Proposal Type",
    "",
    "amend",
    "",
    "## Category",
    "",
    "<!-- model-releases / research / industry / policy / tools-oss -->",
    "<!-- Informational; the target rule keeps its category. -->",
    "",
    "model-releases",
    "",
    "## Target Rule",
    "",
    "<!-- Existing rule id to replace. Format: group-item (e.g., 3-1). -->",
    "1-1",
  ].join("\n");
  assert.equal(parseCategory(body), "model-releases");
  assert.equal(parseCategory("## Category\n\nindustry\n"), "industry");
  assert.equal(parseCategory("## Category\n\n<!-- only a comment -->\n"), null);
  assert.equal(parseCategory("## Category\n\nnot-a-slug\n"), null);
  assert.equal(parseCategory("no section"), null);
});

test("parseRuleText strips template comments and keeps prose", () => {
  const body = [
    "## Rule Text",
    "",
    "<!-- English. Full replacement text (not a diff). -->",
    '<!-- Good: "Include items..." -->',
    "Include items that announce a new AI model.",
  ].join("\n");
  assert.equal(parseRuleText(body), "Include items that announce a new AI model.");
  assert.equal(parseRuleText("## Rule Text\n\n\n"), "");
});

test("parseTargetGroup reads ## Target Group N line", () => {
  assert.equal(parseTargetGroup("## Target Group\n\n3\n"), "3");
  assert.equal(parseTargetGroup("no target"), null);
  assert.equal(
    parseTargetGroup(
      "## Target Group\n\n<!-- Group number to add the item to (e.g., 3). -->\n3\n",
    ),
    "3",
  );
});

test("loadActiveRules returns groups and items", () => {
  const dir = tmpRules();
  const { groups, items, skipped } = loadActiveRules(dir);
  assert.equal(groups.length, 2);
  assert.equal(items.length, 2);
  assert.equal(skipped.length, 0);
  assert.equal(groups[0].id, "1-0");
  assert.equal(groups[0].name, "Model Releases");
  assert.equal(items[0].id, "1-1");
  assert.equal(items[0].group, "1");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadActiveItems maps items with group category", () => {
  const dir = tmpRules();
  const items = loadActiveItems(dir);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "1-1");
  assert.equal(items[0].category, "model-releases");
  assert.equal(items[0].groupName, "Model Releases");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findRuleFile loads rule by x-y id", () => {
  const dir = tmpRules();
  const hit = findRuleFile(dir, "3-1");
  assert.ok(hit);
  assert.equal(hit.path, "rules/3-1.md");
  assert.equal(hit.category, "industry");
  assert.equal(hit.type, "item");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildRuleFile item has type/version/group", () => {
  const md = buildRuleFile({
    id: "1-2",
    type: "item",
    group: "1",
    category: "model-releases",
    text: "Include new model launches.",
    version: 1,
  });
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.id, "1-2");
  assert.equal(data.type, "item");
  assert.equal(data.group, "1");
  assert.equal(data.version, "1");
  assert.match(body, /new model launches/);
});

test("buildRuleFile group has name and type group", () => {
  const md = buildRuleFile({
    id: "2-0",
    type: "group",
    category: "research",
    name: "Research",
    text: "Research group description.",
    version: 1,
  });
  const { data } = parseFrontmatter(md);
  assert.equal(data.id, "2-0");
  assert.equal(data.type, "group");
  assert.equal(data.name, "Research");
});

test("nextFreeItemNumber increments within group", () => {
  const dir = tmpRules();
  const { items } = loadActiveRules(dir);
  assert.equal(nextFreeItemNumber("1", items), 2);
  assert.equal(nextFreeItemNumber("3", items), 2);
  assert.equal(nextFreeItemNumber("5", items), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nextFreeGroupNumber increments max group", () => {
  const dir = tmpRules();
  const { groups } = loadActiveRules(dir);
  assert.equal(nextFreeGroupNumber(groups), 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildRuleFile preserves effectiveAt and writes revokedReason", () => {
  const amended = buildRuleFile({
    id: "1-1",
    type: "item",
    group: "1",
    category: "model-releases",
    text: "Include official model launches.",
    status: "active",
    source: "seed",
    version: 2,
    amendedAt: "2026-09-23",
    effectiveAt: "2026-09-14",
  });
  const a = parseFrontmatter(amended);
  assert.equal(a.data.effective_at, "2026-09-14");
  assert.equal(a.data.amended_at, "2026-09-23");
  assert.equal(a.data.version, "2");
  assert.equal(a.data.source, "seed");
  assert.match(a.body, /Include official model launches/);

  const revoked = buildRuleFile({
    id: "3-1",
    type: "item",
    group: "3",
    category: "industry",
    text: "Industry business events.",
    status: "revoked",
    source: "seed",
    version: 2,
    effectiveAt: "2026-09-14",
    revokedAt: "2026-09-23",
    revokedReason: "Superseded by 3-2\nsecond line",
  });
  const r = parseFrontmatter(revoked);
  assert.equal(r.data.status, "revoked");
  assert.equal(r.data.revoked_at, "2026-09-23");
  assert.equal(r.data.revoked_reason, "Superseded by 3-2 second line");
  // original rule text kept; justification lives in frontmatter
  assert.match(r.body, /Industry business events/);
  assert.doesNotMatch(r.body, /Superseded by/);
});

test("buildRuleFile defaults effective_at to today when omitted", () => {
  const md = buildRuleFile({
    id: "1-2",
    type: "item",
    group: "1",
    category: "model-releases",
    text: "Include new model launches.",
  });
  const { data } = parseFrontmatter(md);
  assert.match(data.effective_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(data.amended_at, "null");
  assert.equal(data.revoked_reason, undefined);
});
