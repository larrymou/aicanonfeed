import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findRuleFile,
  parseTargetRule,
  buildRuleFile,
  parseFrontmatter,
  loadActiveRules,
} from "../lib/rules.mjs";

function tmpRules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicanon-rules-"));
  fs.writeFileSync(
    path.join(dir, "R1-model-releases.md"),
    ["---", "id: R1", "status: active", "source: seed", "category: model-releases", "---", "", "Official model launch with owner link."].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "R3-industry.md"),
    ["---", "id: R3", "status: active", "source: seed", "category: industry", "---", "", "Industry business events."].join("\n"),
  );
  return dir;
}

test("parseTargetRule reads ## Target Rule R# line", () => {
  assert.equal(parseTargetRule("## Target Rule\n\nR3\n"), "R3");
  assert.equal(parseTargetRule("## Proposal Type\n\namend\n\n## Target Rule\nr1"), "R1");
  assert.equal(parseTargetRule("no target"), null);
});

test("findRuleFile loads active rule by id", () => {
  const dir = tmpRules();
  const hit = findRuleFile(dir, "r3");
  assert.ok(hit);
  assert.equal(hit.path, "rules/R3-industry.md");
  assert.equal(hit.category, "industry");
  assert.equal(hit.status, "active");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildRuleFile amend keeps id and can change category", () => {
  const md = buildRuleFile({
    id: "R3",
    category: "policy",
    text: "Include official AI regulation actions.",
    status: "active",
    source: "community",
  });
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.id, "R3");
  assert.equal(data.category, "policy");
  assert.equal(data.status, "active");
  assert.match(body, /official AI regulation/);
});

test("buildRuleFile revoke marks status revoked", () => {
  const md = buildRuleFile({
    id: "R1",
    category: "model-releases",
    text: "Revoked via proposal — superseded.",
    status: "revoked",
    source: "community-revoke",
    revokedAt: "2026-09-21",
  });
  const { data } = parseFrontmatter(md);
  assert.equal(data.status, "revoked");
  assert.equal(data.revoked_at, "2026-09-21");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicanon-rev-"));
  fs.writeFileSync(path.join(dir, "R1-model-releases.md"), md);
  const { active, skipped } = loadActiveRules(dir);
  assert.equal(active.length, 0);
  assert.ok(skipped.some((s) => /status=revoked/.test(s.reason)));
  fs.rmSync(dir, { recursive: true, force: true });
});
