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

export async function listOpenIssuesWithLabel(label) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(
      `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
    );
    all.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  return all;
}

export async function listIssueReactions(issue_number) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(
      `/issues/${issue_number}/reactions?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export async function addLabels(issue_number, labels) {
  return gh(`/issues/${issue_number}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels }),
  });
}

export async function removeLabels(issue_number, labels) {
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
        /* non-fatal */
      }
    } catch {
      /* non-fatal */
    }
  }
}

export async function setLabels(issue_number, add = [], remove = []) {
  if (remove.length) await removeLabels(issue_number, remove);
  if (add.length) await addLabels(issue_number, add);
}

export async function comment(issue_number, body) {
  return gh(`/issues/${issue_number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
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

export async function mergePullRequest(pull_number, { mergeMethod = "squash" } = {}) {
  // GitHub may still be computing mergeability; retry a few times.
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      return await gh(`/pulls/${pull_number}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: mergeMethod }),
      });
    } catch (err) {
      lastErr = err;
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
 */
export async function pullIsMerged(pr) {
  if (!pr) return false;
  if (pr.merged === true) return true;
  if (pr.merged_at) return true;
  if (pr.merged === false) return false;
  try {
    const full = await getPull(pr.number);
    return full.merged === true || Boolean(full.merged_at);
  } catch {
    return Boolean(pr.merged_at);
  }
}

/** List PRs. state: open | closed | all */
export async function listPulls({ state = "open", perPage = 100 } = {}) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/pulls?state=${state}&per_page=${perPage}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

/** Only allow bot writes under rules/ with a safe filename. */
const SAFE_RULE_PATH = /^rules\/R\d+-[a-z0-9-]+\.md$/;

export async function upsertFilePr({
  branch,
  base = "main",
  path: filePath,
  content,
  title,
  body,
  owner,
  repo,
}) {
  if (!SAFE_RULE_PATH.test(filePath)) {
    throw new Error(`Refusing path outside rules allowlist: ${filePath}`);
  }
  if (content.includes("<script") || /javascript:/i.test(content)) {
    throw new Error("Refusing rule content with unsafe markup");
  }
  // Strip YAML frontmatter before scanning the rule body.
  const ruleBody = content.replace(/^---[\s\S]*?---\n/, "");
  const unsafe = scanRuleText(ruleBody);
  if (unsafe) {
    throw new Error(`Refusing rule content (${unsafe})`);
  }
  const baseRef = await gh(`/git/ref/heads/${base}`);
  const baseSha = baseRef.object.sha;

  let headSha = baseSha;
  try {
    const ref = await gh(`/git/refs/heads/${branch}`);
    headSha = ref.object.sha;
  } catch {
    await gh(`/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
    headSha = baseSha;
  }

  const blobRes = await gh(`/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    }),
  });
  const baseCommit = await gh(`/git/commits/${headSha}`);
  const tree = await gh(`/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
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
  try {
    await gh(`/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha }),
    });
  } catch {
    await gh(`/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
    });
  }

  const open = await gh(
    `/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&base=${base}`,
  );
  if (open.length) return open[0];

  return createPullRequest({
    title,
    head: branch,
    base,
    body: body || title,
  });
}
