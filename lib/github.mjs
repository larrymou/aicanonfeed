/** Thin GitHub REST helpers using GITHUB_TOKEN / GH_TOKEN. */
import { scanRuleText } from "./rule-guard.mjs";

function token() {
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN (or GH_TOKEN) is required");
  return t;
}

export function repoSlug() {
  const slug =
    process.env.GITHUB_REPOSITORY ||
    process.env.GH_REPO ||
    (process.env.REPO_SLUG || "").trim();
  if (!slug || !slug.includes("/")) {
    throw new Error("Set GITHUB_REPOSITORY or REPO_SLUG as owner/name");
  }
  return slug;
}

export function splitSlug() {
  const [owner, repo] = repoSlug().split("/");
  return { owner, repo };
}

async function gh(pathname, init = {}) {
  const slug = repoSlug();
  const res = await fetch(`https://api.github.com/repos/${slug}${pathname}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token()}`,
      "User-Agent": "aicanonfeed",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function getRepo() {
  return gh("");
}

/** Public user profile (for account-age checks). Uses the users API, not the repo path. */
export async function getUser(login, { signal = null } = {}) {
  const res = await fetch(
    `https://api.github.com/users/${encodeURIComponent(String(login || ""))}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token()}`,
        "User-Agent": "aicanonfeed",
      },
      signal: signal || AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} users/${login}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Resolve created_at for logins.
 * - success → { ok: true, createdAt }
 * - 404 / definitive miss → { ok: false, reason: "not_found", createdAt: null }
 * - network / 5xx / timeout → { ok: false, reason: "lookup_failed", createdAt: null }
 * Lookup failure must NOT be treated as "ineligible" — it is "not yet known".
 */
export async function resolveUserCreatedAts(
  logins,
  { concurrency = 8, timeoutMs = 120_000 } = {},
) {
  const map = new Map();
  const uniqueLogins = [...new Set((logins || []).filter(Boolean))];
  const workerCount = Math.max(1, Math.min(uniqueLogins.length, Math.floor(concurrency) || 1));
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let nextIndex = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < uniqueLogins.length) {
      const login = uniqueLogins[nextIndex++];
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        map.set(login, { ok: false, createdAt: null, reason: "lookup_failed" });
        continue;
      }
      try {
        const u = await getUser(login, {
          signal: AbortSignal.timeout(Math.min(30_000, remainingMs)),
        });
        map.set(login, { ok: true, createdAt: u?.created_at || null, reason: null });
      } catch (err) {
        const msg = String(err.message || err);
        const notFound = /GitHub 404\b/.test(msg) || (/\b404\b/.test(msg) && /users\//.test(msg));
        map.set(login, {
          ok: false,
          createdAt: null,
          reason: notFound ? "not_found" : "lookup_failed",
        });
      }
    }
  });
  await Promise.all(workers);
  return map;
}

/**
 * Paginate a list endpoint until a short page or a safety cap.
 * Throws when the cap is hit on a full page — truncated data must never be
 * treated as complete (votes / queues would silently lose items).
 */
async function ghPaginate(pathname, { maxPages = 30 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = pathname.includes("?") ? "&" : "?";
    const batch = await gh(`${pathname}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) return all;
    if (page === maxPages) {
      throw new Error(
        `pagination truncated at ${maxPages} pages (${all.length}+ items) for ${pathname}`,
      );
    }
  }
  return all;
}

export async function listOpenIssuesWithLabel(label) {
  const batch = await ghPaginate(`/issues?state=open&labels=${encodeURIComponent(label)}`);
  return batch.filter((i) => !i.pull_request);
}

/** List issues (not PRs). `since` is ISO and filters `created_at` client-side (API `since` is updated_at). */
export async function listIssues({ state = "all", creator = null, since = null, maxPages = 30 } = {}) {
  const params = new URLSearchParams({ state });
  if (creator) params.set("creator", creator);
  // Push `since` to the API so authors with long histories do not force a
  // full-history paginate. API `since` filters updated_at (>= created_at), so
  // a same-day create is never dropped; the client-side created_at filter below
  // remains the authority for the day window.
  if (since) params.set("since", since);
  const batch = await ghPaginate(`/issues?${params}`, { maxPages });
  const sinceMs = since ? Date.parse(since) : null;
  const all = [];
  for (const issue of batch) {
    if (issue.pull_request) continue;
    if (sinceMs != null) {
      const created = Date.parse(issue.created_at || "");
      if (!Number.isFinite(created) || created < sinceMs) continue;
    }
    all.push(issue);
  }
  return all;
}

/**
 * Issues created on a specific UTC day (YYYY-MM-DD) by `creator`.
 * Uses the search API's `created:` qualifier so authors with long histories
 * (many later `updated_at` touches) cannot exhaust list pagination.
 */
export async function listIssuesCreatedOnDay({ creator, day, maxPages = 5 } = {}) {
  const dayStr = String(day || "").slice(0, 10);
  if (!creator || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
    throw new Error("listIssuesCreatedOnDay: creator and day (YYYY-MM-DD) required");
  }
  const q = `repo:${repoSlug()} author:${creator} created:${dayStr} is:issue`;
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    // Search lives at api.github.com/search — not under /repos/.
    const res = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token()}`,
          "User-Agent": "aicanonfeed",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${res.status} search/issues: ${text.slice(0, 200)}`);
    }
    const batch = await res.json();
    // Search can return a short page while still incomplete — never treat
    // that as the full day (quota would under-count same-day siblings).
    if (batch?.incomplete_results === true) {
      throw new Error(`search incomplete_results for ${q}`);
    }
    const items = Array.isArray(batch?.items) ? batch.items : [];
    for (const item of items) {
      if (item.pull_request) continue;
      all.push(item);
    }
    if (items.length < 100) return all;
    if (page === maxPages) {
      throw new Error(`search truncated at ${maxPages} pages for ${q}`);
    }
  }
  return all;
}

export async function listIssueReactions(issue_number) {
  return ghPaginate(`/issues/${issue_number}/reactions`);
}

export async function addLabels(issue_number, labels) {
  return gh(`/issues/${issue_number}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels }),
  });
}

export async function removeLabels(issue_number, labels) {
  const failures = [];
  for (const name of labels) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repoSlug()}/issues/${issue_number}/labels/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token()}`,
            "User-Agent": "aicanonfeed",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok && res.status !== 404) {
        failures.push(`${name}: HTTP ${res.status}`);
      }
    } catch (err) {
      failures.push(`${name}: ${String(err.message || err).slice(0, 120)}`);
    }
  }
  if (failures.length) {
    throw new Error(`removeLabels failed: ${failures.join("; ")}`);
  }
}

/** Replace the full label set in one request. */
export async function replaceLabels(issue_number, labels) {
  return gh(`/issues/${issue_number}/labels`, {
    method: "PUT",
    body: JSON.stringify({ labels: labels || [] }),
  });
}

/**
 * Apply only the requested label delta. A full-set PUT can erase labels added
 * by a maintainer between its read and write, so preserve unrelated labels by
 * using GitHub's add/remove endpoints. Add the new state first; if removal of
 * the old state fails, best-effort compensation restores the prior state.
 */
export async function setLabels(issue_number, add = [], remove = []) {
  const addList = [...new Set(add || [])];
  const removeList = [...new Set(remove || [])].filter((n) => !addList.includes(n));
  let names;
  try {
    const current = await ghPaginate(`/issues/${issue_number}/labels`, { maxPages: 10 });
    names = (Array.isArray(current) ? current : []).map((l) =>
      typeof l === "string" ? l : l?.name,
    );
  } catch (err) {
    throw new Error(
      `setLabels: cannot read current labels for #${issue_number}: ${String(err.message || err).slice(0, 200)}`,
    );
  }
  const current = new Set(names.filter(Boolean));
  const additions = addList.filter((name) => !current.has(name));
  const removals = removeList.filter((name) => current.has(name));

  if (additions.length) await addLabels(issue_number, additions);
  try {
    if (removals.length) await removeLabels(issue_number, removals);
  } catch (err) {
    const rollbackErrors = [];
    if (removals.length) {
      try {
        await addLabels(issue_number, removals);
      } catch (rollbackErr) {
        rollbackErrors.push(`restore old labels: ${String(rollbackErr.message || rollbackErr)}`);
      }
    }
    if (additions.length) {
      try {
        await removeLabels(issue_number, additions);
      } catch (rollbackErr) {
        rollbackErrors.push(`remove new labels: ${String(rollbackErr.message || rollbackErr)}`);
      }
    }
    throw new Error(
      `setLabels: could not remove old labels: ${String(err.message || err).slice(0, 160)}` +
        (rollbackErrors.length ? `; rollback failed: ${rollbackErrors.join("; ").slice(0, 200)}` : ""),
    );
  }
  return names;
}

export async function comment(issue_number, body) {
  return gh(`/issues/${issue_number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/** Post a comment only when its stable marker is absent from issue history. */
let cachedViewerLogin = null;

/** Authenticated account login — used so commentOnce works for any bot identity. */
export async function viewerLogin() {
  if (cachedViewerLogin) return cachedViewerLogin;
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token()}`,
      "User-Agent": "aicanonfeed",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} /user`);
  const data = await res.json();
  cachedViewerLogin = String(data?.login || "").toLowerCase();
  return cachedViewerLogin;
}

export async function commentOnce(issue_number, marker, body) {
  if (!marker || !String(body || "").trim()) {
    throw new Error("commentOnce requires a marker and non-empty body");
  }
  const comments = await ghPaginate(`/issues/${issue_number}/comments`);
  const me = await viewerLogin().catch(() => "github-actions[bot]");
  if (
    comments.some(
      (entry) =>
        String(entry.user?.login || "").toLowerCase() === me &&
        String(entry.body || "").includes(marker),
    )
  ) {
    return { created: false };
  }
  await comment(issue_number, `${body}\n\n${marker}`);
  return { created: true };
}

export async function closeIssue(issue_number) {
  return gh(`/issues/${issue_number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}

export async function createPullRequest({ title, head, base, body }) {
  return gh(`/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
  });
}

/**
 * Merge a PR. When `expectedSha` is set, the merge request carries GitHub's
 * `sha` guard so a concurrently-updated branch cannot land unapproved content.
 */
export async function mergePullRequest(
  pull_number,
  { mergeMethod = "squash", expectedSha = null } = {},
) {
  // GitHub may still be computing mergeability; retry transient errors only.
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      return await gh(`/pulls/${pull_number}/merge`, {
        method: "PUT",
        body: JSON.stringify({
          merge_method: mergeMethod,
          ...(expectedSha ? { sha: expectedSha } : {}),
        }),
      });
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || "");
      // 409 sha mismatch / 405 not mergeable / 422 validation are final.
      if (/\b(409|405|422)\b/.test(msg)) throw lastErr;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function getPull(pull_number) {
  return gh(`/pulls/${pull_number}`);
}

/**
 * List API often omits boolean `merged`; trust merged_at, else fetch the PR.
 * Returns true/false when known, or null when merge state cannot be confirmed
 * (callers must defer — never treat unknown as "not merged").
 */
export async function pullIsMerged(pr) {
  if (!pr) return null;
  if (pr.merged === true) return true;
  if (pr.merged_at) return true;
  if (pr.merged === false) return false;
  try {
    const full = await getPull(pr.number);
    if (full.merged === true || Boolean(full.merged_at)) return true;
    if (full.merged === false || full.state === "closed") return false;
    return null;
  } catch {
    // Detail lookup failed and the list payload is inconclusive.
    return null;
  }
}

/**
 * Check whether a commit is contained in a ref. Comparing commit→ref means
 * `ahead` or `identical` confirms the ref includes the commit.
 */
export async function isCommitReachableFromRef(commitSha, ref) {
  if (!commitSha || !ref) return false;
  const comparison = await gh(
    `/compare/${encodeURIComponent(commitSha)}...${encodeURIComponent(ref)}`,
  );
  return comparison.status === "ahead" || comparison.status === "identical";
}

/** List PRs. state: open | closed | all */
export async function listPulls({ state = "open", maxPages = 30 } = {}) {
  return ghPaginate(`/pulls?state=${state}`, { maxPages });
}

/** Only allow bot writes under rules/ with a safe filename. */
const SAFE_RULE_PATH = /^rules\/\d+-\d+\.md$/;

export function validateRuleBranchDiff({
  parentEntries,
  headEntries,
  currentBaseEntries,
  filePath,
  expectedBlobSha,
}) {
  const files = (entries) => (entries || []).filter((entry) => entry.type !== "tree");
  const before = new Map(files(parentEntries).map((entry) => [entry.path, entry]));
  const after = new Map(files(headEntries).map((entry) => [entry.path, entry]));
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter((p) => {
    const a = before.get(p);
    const b = after.get(p);
    return a?.sha !== b?.sha || a?.mode !== b?.mode || a?.type !== b?.type;
  });
  if (
    changedPaths.length > 1 ||
    (changedPaths.length === 1 && changedPaths[0] !== filePath) ||
    (changedPaths.length === 1 && after.get(filePath)?.sha !== expectedBlobSha)
  ) {
    return { ok: false, reason: "existing commit differs from the frozen rule change" };
  }
  const ruleSha = (entries) => files(entries).find((entry) => entry.path === filePath)?.sha || null;
  if (ruleSha(parentEntries) !== ruleSha(currentBaseEntries)) {
    return { ok: false, reason: "target rule changed on base after this PR was created" };
  }
  return {
    ok: true,
    changedPaths,
    alreadyApplied: after.get(filePath)?.sha === expectedBlobSha,
  };
}

async function verifyMergedRulePr({ pr, base, filePath, content }) {
  const headSha = pr.head?.sha;
  if (!headSha) throw new Error(`upsertFilePr: merged PR #${pr.number} has no head SHA`);
  const mergeCommitSha = pr.merge_commit_sha;
  if (!mergeCommitSha) {
    throw new Error(`upsertFilePr: merged PR #${pr.number} has no merge commit SHA`);
  }
  if (!(await isCommitReachableFromRef(mergeCommitSha, base))) {
    throw new Error(`upsertFilePr: merged PR #${pr.number} merge commit is not on ${base}`);
  }
  const blob = await gh(`/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    }),
  });
  const [mergeCommit, headCommit, pullCommits] = await Promise.all([
    gh(`/git/commits/${mergeCommitSha}`),
    gh(`/git/commits/${headSha}`),
    ghPaginate(`/pulls/${pr.number}/commits`),
  ]);
  if (!Array.isArray(pullCommits) || !pullCommits.length ||
      pullCommits[pullCommits.length - 1]?.sha !== headSha) {
    throw new Error(`upsertFilePr: cannot verify commit list for merged PR #${pr.number}`);
  }
  for (const commit of pullCommits) {
    const detail = await gh(`/commits/${commit.sha}`);
    // Merge commits (e.g. maintainer merged main into the PR branch) may
    // legitimately touch unrelated paths — only non-merge commits must stay
    // inside the frozen rule file.
    if ((detail.parents || []).length > 1) continue;
    if (!Array.isArray(detail.files) ||
        detail.files.some((file) => file.filename !== filePath)) {
      throw new Error(
        `upsertFilePr: merged PR #${pr.number} contains changes outside the frozen rule content`,
      );
    }
  }
  const parents = mergeCommit.parents || [];
  if (!parents.length || parents.length > 2) {
    throw new Error(`upsertFilePr: unsupported merge topology for merged PR #${pr.number}`);
  }
  const baseParent = parents.length === 2
    ? parents.find((parent) => parent.sha !== headSha)
    : parents[0];
  if (!baseParent?.sha) {
    throw new Error(`upsertFilePr: cannot identify base parent for merged PR #${pr.number}`);
  }
  const baseParentCommit = await gh(`/git/commits/${baseParent.sha}`);
  const [mergedTree, headTree, baseParentTree] = await Promise.all([
    gh(`/git/trees/${mergeCommit.tree.sha}?recursive=1`),
    gh(`/git/trees/${headCommit.tree.sha}?recursive=1`),
    gh(`/git/trees/${baseParentCommit.tree.sha}?recursive=1`),
  ]);
  if (mergedTree.truncated || headTree.truncated || baseParentTree.truncated) {
    throw new Error(`upsertFilePr: tree comparison truncated for merged PR #${pr.number}`);
  }
  const ruleSha = (tree) =>
    (tree.tree || []).find((entry) => entry.path === filePath && entry.type !== "tree")?.sha || null;
  if (ruleSha(mergedTree) !== blob.sha) {
    throw new Error(`upsertFilePr: merge commit for PR #${pr.number} did not apply the frozen rule content`);
  }
  if (ruleSha(headTree) !== blob.sha) {
    throw new Error(`upsertFilePr: merged PR #${pr.number} head does not match the frozen rule content`);
  }
  const mergedDiff = validateRuleBranchDiff({
    parentEntries: baseParentTree.tree,
    headEntries: mergedTree.tree,
    currentBaseEntries: baseParentTree.tree,
    filePath,
    expectedBlobSha: blob.sha,
  });
  if (!mergedDiff.ok || !mergedDiff.alreadyApplied) {
    throw new Error(
      `upsertFilePr: merged PR #${pr.number} contains changes outside the frozen rule content`,
    );
  }
}

export async function upsertFilePr({
  branch,
  base = "main",
  path: filePath,
  content,
  title,
  body,
  owner,
}) {
  if (!SAFE_RULE_PATH.test(filePath)) {
    throw new Error(`Refusing path outside rules allowlist: ${filePath}`);
  }
  if (/<script|javascript:|onerror=|onload=/i.test(content)) {
    throw new Error("Refusing rule content with unsafe markup");
  }
  // Strip YAML frontmatter before scanning the rule body.
  const ruleBody = content.replace(/^---[\s\S]*?---\n/, "");
  const unsafe = scanRuleText(ruleBody);
  if (unsafe) {
    throw new Error(`Refusing rule content (${unsafe})`);
  }

  // A PR for this branch may already exist (open, closed, or merged) if a
  // previous attempt was interrupted after create. Never open a second PR.
  const existing = await ghPaginate(
    `/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&base=${base}`,
    { maxPages: 5 },
  );
  if (existing.length) {
    // Prefer the newest PR for this head — listing order is not guaranteed.
    const prior = [...existing].sort((a, b) => Number(b.number) - Number(a.number))[0];
    const merged = await pullIsMerged(prior);
    if (merged === true) {
      await verifyMergedRulePr({ pr: prior, base, filePath, content });
      return prior;
    }
    if (merged === null) {
      throw new Error(`upsertFilePr: cannot confirm merge state of existing PR #${prior.number}`);
    }
    // Still open — fall through to refresh the branch content, then return it.
    if (prior.state === "open") {
      const expectedSha = await writeRuleBranch({ branch, base, filePath, content, title });
      const refreshed = await gh(`/pulls/${prior.number}`);
      if (refreshed.head?.sha !== expectedSha) {
        throw new Error(`upsertFilePr: PR #${prior.number} head changed during verification`);
      }
      return refreshed;
    }
    // Closed unmerged: leave it; caller must inspect. Do not create a sibling.
    throw new Error(`upsertFilePr: branch ${branch} already has closed unmerged PR #${prior.number}`);
  }

  const expectedSha = await writeRuleBranch({ branch, base, filePath, content, title });
  const pr = await createPullRequest({
    title,
    head: branch,
    base,
    body: body || title,
  });
  if (pr.head?.sha !== expectedSha) {
    throw new Error(`upsertFilePr: created PR head does not match the generated commit`);
  }
  return pr;
}

async function writeRuleBranch({ branch, base, filePath, content, title }) {
  const baseRef = await gh(`/git/ref/heads/${base}`);
  const baseSha = baseRef.object.sha;
  const blobRes = await gh(`/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    }),
  });
  let branchRef = null;
  try {
    branchRef = await gh(`/git/ref/heads/${branch}`);
  } catch (err) {
    if (/^GitHub 404\b/.test(String(err.message || err))) {
      // A missing branch is the only case where creating a new ref is safe.
      await gh(`/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
      });
    } else {
      throw err;
    }
  }

  const headSha = branchRef?.object?.sha || baseSha;
  const headCommit = await gh(`/git/commits/${headSha}`);
  const headTree = await gh(`/git/trees/${headCommit.tree.sha}?recursive=1`);
  if (headTree.truncated) {
    throw new Error(`Refusing to update ${branch}: branch tree comparison was truncated`);
  }

  if (branchRef) {
    const comparison = await gh(`/compare/${baseSha}...${headSha}`);
    const mergeBaseSha = comparison.merge_base_commit?.sha;
    if (!mergeBaseSha) {
      throw new Error(`Refusing to update ${branch}: could not determine its merge base`);
    }
    const [mergeBaseCommit, currentBaseCommit] = await Promise.all([
      gh(`/git/commits/${mergeBaseSha}`),
      gh(`/git/commits/${baseSha}`),
    ]);
    const [mergeBaseTree, currentBaseTree] = await Promise.all([
      gh(`/git/trees/${mergeBaseCommit.tree.sha}?recursive=1`),
      gh(`/git/trees/${currentBaseCommit.tree.sha}?recursive=1`),
    ]);
    if (mergeBaseTree.truncated || currentBaseTree.truncated) {
      throw new Error(`Refusing to update ${branch}: base tree comparison was truncated`);
    }
    const diff = validateRuleBranchDiff({
      parentEntries: mergeBaseTree.tree,
      headEntries: headTree.tree,
      currentBaseEntries: currentBaseTree.tree,
      filePath,
      expectedBlobSha: blobRes.sha,
    });
    if (!diff.ok) throw new Error(`Refusing to update ${branch}: ${diff.reason}`);
    if (diff.alreadyApplied) return headSha;
  }

  const tree = await gh(`/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: headCommit.tree.sha,
      tree: [{ path: filePath, mode: "100644", type: "blob", sha: blobRes.sha }],
    }),
  });
  const newCommit = await gh(`/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: title,
      tree: tree.sha,
      parents: [headSha],
    }),
  });
  await gh(`/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  return newCommit.sha;
}
