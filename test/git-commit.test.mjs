import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasDirtyTrackedPaths, commitPaths } from "../lib/git-commit.mjs";

function tmpRepoWithOrigin() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aicanonfeed-git-"));
  const originDir = path.join(base, "origin.git");
  const workDir = path.join(base, "work");
  execFileSync("git", ["init", "--bare", originDir], { cwd: base, stdio: "pipe" });
  fs.mkdirSync(workDir);
  execFileSync("git", ["init"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir, stdio: "pipe" });
  fs.writeFileSync(path.join(workDir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", originDir], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: workDir, stdio: "pipe" });
  return { base, workDir };
}

test("hasDirtyTrackedPaths distinguishes untracked from modified tracked", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  try {
    fs.writeFileSync(path.join(workDir, "new-untracked.txt"), "x\n");
    assert.equal(hasDirtyTrackedPaths(workDir), false, "untracked-only should not count as dirty tracked");

    fs.appendFileSync(path.join(workDir, "seed.txt"), "more\n");
    assert.equal(hasDirtyTrackedPaths(workDir), true, "modified tracked file is dirty");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("hasDirtyTrackedPaths detects a staged new file", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  try {
    fs.writeFileSync(path.join(workDir, "staged-new.txt"), "new\n");
    execFileSync("git", ["add", "staged-new.txt"], { cwd: workDir, stdio: "pipe" });
    assert.equal(hasDirtyTrackedPaths(workDir), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("commitPaths sets identity and succeeds with untracked noise (no dirty tracked)", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  try {
    fs.writeFileSync(path.join(workDir, "noise.json"), "{}\n");
    fs.writeFileSync(path.join(workDir, "snap.json"), '{"frozen":true}\n');
    const res = commitPaths(["snap.json"], "chore: freeze snapshot", { cwd: workDir });
    assert.equal(res.ok, true, String(res.error));
    const log = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    assert.equal(log, "chore: freeze snapshot");
    // Identity is embedded in commitPaths; author may be overwritten by repo config,
    // but the commit must exist on origin.
    const remoteLog = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: originDirFrom(base),
      encoding: "utf8",
    }).trim();
    assert.equal(remoteLog, "chore: freeze snapshot");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("commitPaths leaves unrelated staged files out of the targeted commit", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  try {
    fs.writeFileSync(path.join(workDir, "snap.json"), '{"frozen":true}\n');
    fs.writeFileSync(path.join(workDir, "unrelated.txt"), "keep staged\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: workDir, stdio: "pipe" });

    const res = commitPaths(["snap.json"], "chore: freeze snapshot", { cwd: workDir });
    assert.equal(res.ok, true, String(res.error));
    assert.deepEqual(
      execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
        cwd: workDir,
        encoding: "utf8",
      }).trim().split("\n").sort(),
      ["snap.json"],
    );
    assert.equal(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: workDir,
        encoding: "utf8",
      }).trim(),
      "unrelated.txt",
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("commitPaths checkpoints decisions with dirty local files and a moved remote main", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  const peerDir = path.join(base, "peer");
  try {
    execFileSync("git", ["clone", "--branch", "main", originDirFrom(base), peerDir], {
      cwd: base,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.name", "peer"], { cwd: peerDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "peer@example.com"], { cwd: peerDir, stdio: "pipe" });
    fs.writeFileSync(path.join(peerDir, "remote.txt"), "remote\n");
    execFileSync("git", ["add", "remote.txt"], { cwd: peerDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "remote advances"], { cwd: peerDir, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "main"], { cwd: peerDir, stdio: "pipe" });

    fs.mkdirSync(path.join(workDir, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "decisions", "index.jsonl"), '{"urlHash":"item"}\n');
    fs.writeFileSync(path.join(workDir, "decisions", "research.jsonl"), '{"event":"pending"}\n');
    const res = commitPaths(["decisions"], "chore: checkpoint research audit", { cwd: workDir });

    assert.equal(res.ok, true, String(res.error));
    assert.equal(fs.readFileSync(path.join(workDir, "remote.txt"), "utf8"), "remote\n");
    assert.equal(
      execFileSync("git", ["show", "origin/main:decisions/research.jsonl"], {
        cwd: workDir,
        encoding: "utf8",
      }),
      '{"event":"pending"}\n',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function originDirFrom(base) {
  return path.join(base, "origin.git");
}

test("commitPaths refuses rebase when push fails and tracked tree is dirty", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  try {
    // Make push fail so the rebase fallback is exercised.
    execFileSync("git", ["remote", "set-url", "origin", path.join(base, "missing.git")], {
      cwd: workDir,
      stdio: "pipe",
    });
    fs.writeFileSync(path.join(workDir, "snap.json"), '{"frozen":true}\n');
    fs.appendFileSync(path.join(workDir, "seed.txt"), "dirty\n");
    const res = commitPaths(["snap.json"], "chore: freeze snapshot", { cwd: workDir });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /dirty|push|rebase|origin/i);
    assert.match(
      fs.readFileSync(path.join(workDir, "seed.txt"), "utf8"),
      /dirty/,
      "must not blow away unstaged tracked edits",
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});


test("commitPaths embeds bot identity (no local user config required)", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  try {
    // Wipe local identity to mimic a clean Actions runner.
    execFileSync("git", ["config", "--unset", "user.name"], { cwd: workDir, stdio: "pipe" });
    execFileSync("git", ["config", "--unset", "user.email"], { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "snap.json"), '{"frozen":true}\n');
    const res = commitPaths(["snap.json"], "chore: freeze snapshot", { cwd: workDir });
    assert.equal(res.ok, true, String(res.error));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("commitPaths bounds a stalled Git command", () => {
  const { base, workDir } = tmpRepoWithOrigin();
  try {
    const hookDir = path.join(workDir, ".git", "hooks");
    const hookPath = path.join(hookDir, "pre-push");
    fs.writeFileSync(hookPath, "#!/bin/sh\nexec sleep 2\n");
    fs.chmodSync(hookPath, 0o755);
    fs.writeFileSync(path.join(workDir, "snap.json"), '{"frozen":true}\n');

    const startedAt = Date.now();
    const res = commitPaths(
      ["snap.json"],
      "chore: freeze snapshot",
      { cwd: workDir, timeoutMs: 100 },
    );
    assert.equal(res.ok, false);
    assert.match(String(res.error), /timed out|ETIMEDOUT|SIGTERM|signal/i);
    assert.ok(Date.now() - startedAt < 1500, "Git helper should return within the configured bound");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
