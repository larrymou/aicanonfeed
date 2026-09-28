import { execFileSync } from "node:child_process";

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

const GIT_IDENTITY = [
  "-c",
  "user.name=aicanonfeed-bot",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];

function runGit(args, { cwd = process.cwd(), timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    timeout: Math.max(1, Number(timeoutMs) || DEFAULT_GIT_TIMEOUT_MS),
    killSignal: "SIGTERM",
  });
}

/**
 * True when the working tree has unstaged/uncommitted changes to tracked files.
 * Untracked files alone do not block a safe push of a targeted commit.
 */
export function hasDirtyTrackedPaths(cwd = process.cwd(), timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
  const status = runGit(["status", "--porcelain"], { cwd, timeoutMs });
  return status
    .split("\n")
    .some((line) => line && line.slice(0, 2) !== "??");
}

/**
 * Fast-forward local to origin/main when possible (after remote merges).
 * Never discards local work — ff-only merge; reports whether we are in sync.
 */
export function syncWithOrigin({ cwd = process.cwd(), timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  try {
    runGit(["fetch", "origin", "main"], { cwd, timeoutMs });
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
  if (hasDirtyTrackedPaths(cwd, timeoutMs)) {
    return { ok: false, error: "tracked worktree dirty; not syncing" };
  }
  try {
    runGit(["merge", "--ff-only", "FETCH_HEAD"], { cwd, timeoutMs });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `ff-only merge failed (local may be ahead/diverged): ${String(err.message || err).slice(0, 200)}`,
    };
  }
}

/**
 * True when local HEAD has commits not yet on origin/main.
 * Used so "no new path changes" cannot be mistaken for "decisions are remote".
 */
export function isAheadOfOrigin(cwd = process.cwd(), timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
  try {
    runGit(["fetch", "origin", "main"], { cwd, timeoutMs });
    const rev = runGit(["rev-list", "--count", "origin/main..HEAD"], { cwd, timeoutMs }).trim();
    return Number(rev) > 0;
  } catch {
    // Cannot confirm — treat as ahead (fail-closed for persistence checks).
    return true;
  }
}

/**
 * Commit and push specific paths (mid-run snapshot freeze).
 * - Always sets a bot identity so clean Actions runners can commit.
 * - Syncs with origin first (same-cycle rule merges advance remote main).
 * - Never runs `pull --rebase` on a dirty tracked tree without first
 *   committing the listed paths; untracked noise is tolerated.
 * - "No local path changes" is only success when HEAD is also on origin —
 *   a prior commit that failed to push must not look persisted.
 */
export function commitPaths(paths, message, {
  cwd = process.cwd(),
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
} = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, error: "no paths" };
  try {
    runGit(["add", "--", ...list], { cwd, timeoutMs });
    const status = runGit(["status", "--porcelain", "--", ...list], { cwd, timeoutMs });
    if (!status.trim()) {
      // No new changes in these paths — but earlier decision commits may still
      // be unpushed. Confirm remote has HEAD before reporting success.
      if (isAheadOfOrigin(cwd, timeoutMs)) {
        try {
          runGit(["push", "origin", "HEAD"], { cwd, timeoutMs });
          return { ok: true, skipped: true, pushedPending: true };
        } catch (pushErr) {
          return {
            ok: false,
            skipped: true,
            error: `no path changes but push of pending commits failed: ${String(pushErr.message || pushErr).slice(0, 240)}`,
          };
        }
      }
      return { ok: true, skipped: true };
    }
    runGit([...GIT_IDENTITY, "commit", "-m", message, "--", ...list], { cwd, timeoutMs });
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 400) };
  }

  // Advance to origin/main if we are only behind (e.g. same-cycle auto-merge).
  const synced = syncWithOrigin({ cwd, timeoutMs });
  if (!synced.ok && hasDirtyTrackedPaths(cwd, timeoutMs)) {
    // Snapshot commit itself succeeded; try push anyway below.
  }

  try {
    runGit(["push", "origin", "HEAD"], { cwd, timeoutMs });
    return { ok: true, skipped: false };
  } catch (pushErr) {
    if (hasDirtyTrackedPaths(cwd, timeoutMs)) {
      return {
        ok: false,
        error: `push failed and tracked worktree is dirty (refusing rebase): ${String(pushErr.message || pushErr).slice(0, 240)}`,
      };
    }
    try {
      runGit(["pull", "--rebase", "origin", "main"], { cwd, timeoutMs });
      runGit(["push", "origin", "HEAD"], { cwd, timeoutMs });
      return { ok: true, skipped: false, rebased: true };
    } catch (err) {
      return {
        ok: false,
        error: `push/rebase failed: ${String(err.message || err).slice(0, 240)}`,
      };
    }
  }
}
