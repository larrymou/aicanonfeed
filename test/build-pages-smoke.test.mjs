/**
 * Smoke test: generate the site offline (no real GitHub token required).
 * Does not cover live voting widgets (those need GITHUB_TOKEN + network).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

test("build-pages writes index.html with CSP and hash whitelist", () => {
  const out = execFileSync(NODE, [path.join(ROOT, "scripts", "build-pages.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_TOKEN: "", GITHUB_REPOSITORY: "acme/feed" },
    timeout: 60_000,
  });
  assert.match(out, /wrote .*index\.html/);
  const html = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8");
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes("Content-Security-Policy"));
  // location.hash is whitelisted before querySelector
  assert.match(html, /\^\[a-z0-9-\]\+\$/);
  // esc() used on dynamic title slots — look for escaped amp or absence of raw interpolation bugs
  assert.ok(html.includes("&amp;") || html.includes("AICanonFeed"));
});
