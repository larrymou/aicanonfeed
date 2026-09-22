import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findRuleFile,
  parseTargetRule,
  parseTargetGroup,
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
});

test("parseTargetGroup reads ## Target Group N line", () => {
  assert.equal(parseTargetGroup("## Target Group\n\n3\n"), "3");
  assert.equal(parseTargetGroup("no target"), null);
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
