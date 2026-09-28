import test from "node:test";
import assert from "node:assert/strict";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "acme/feed";
const {
  validateRuleBranchDiff,
  upsertFilePr,
  isCommitReachableFromRef,
} = await import("../lib/github.mjs");

const baseEntries = [
  { path: "rules/1-0.md", type: "blob", mode: "100644", sha: "group" },
  { path: "rules/1-1.md", type: "blob", mode: "100644", sha: "old-rule" },
];

test("branch validation accepts only the frozen target rule change", () => {
  const result = validateRuleBranchDiff({
    parentEntries: baseEntries,
    headEntries: [
      ...baseEntries.filter((entry) => entry.path !== "rules/1-1.md"),
      { path: "rules/1-1.md", type: "blob", mode: "100644", sha: "frozen-rule" },
      { path: "rules", type: "tree", mode: "040000", sha: "changed-tree" },
    ],
    currentBaseEntries: baseEntries,
    filePath: "rules/1-1.md",
    expectedBlobSha: "frozen-rule",
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyApplied, true);
  assert.deepEqual(result.changedPaths, ["rules/1-1.md"]);
});

test("branch validation rejects unrelated paths and changed rule content", () => {
  const withExtraFile = validateRuleBranchDiff({
    parentEntries: baseEntries,
    headEntries: [
      ...baseEntries,
      { path: "README.md", type: "blob", mode: "100644", sha: "extra" },
      { path: "rules/1-1.md", type: "blob", mode: "100644", sha: "frozen-rule" },
    ],
    currentBaseEntries: baseEntries,
    filePath: "rules/1-1.md",
    expectedBlobSha: "frozen-rule",
  });
  assert.equal(withExtraFile.ok, false);

  const changedRule = validateRuleBranchDiff({
    parentEntries: baseEntries,
    headEntries: [
      { ...baseEntries[0] },
      { ...baseEntries[1], sha: "maintainer-edit" },
    ],
    currentBaseEntries: baseEntries,
    filePath: "rules/1-1.md",
    expectedBlobSha: "frozen-rule",
  });
  assert.equal(changedRule.ok, false);
});

test("branch validation rejects concurrent edits to the target on base", () => {
  const currentBaseEntries = [
    baseEntries[0],
    { ...baseEntries[1], sha: "new-main-rule" },
  ];
  const result = validateRuleBranchDiff({
    parentEntries: baseEntries,
    headEntries: [
      baseEntries[0],
      { ...baseEntries[1], sha: "frozen-rule" },
    ],
    currentBaseEntries,
    filePath: "rules/1-1.md",
    expectedBlobSha: "frozen-rule",
  });
  assert.equal(result.ok, false);
});

async function withMergedPrApi(
  {
    headRuleSha = "frozen-rule",
    baseRuleSha = "frozen-rule",
    mergeRuleSha = "frozen-rule",
    extraFile = false,
    extraMergedFile = false,
  },
  callback,
) {
  const originalFetch = globalThis.fetch;
  const baseEntries = [
    { path: "rules/1-1.md", type: "blob", mode: "100644", sha: baseRuleSha },
  ];
  const mergeEntries = [
    { path: "rules/1-1.md", type: "blob", mode: "100644", sha: mergeRuleSha },
    ...(extraMergedFile
      ? [{ path: "README.md", type: "blob", mode: "100644", sha: "unapproved" }]
      : []),
  ];
  const headEntries = [
    { path: "rules/1-1.md", type: "blob", mode: "100644", sha: headRuleSha },
    ...(extraFile
      ? [{ path: "README.md", type: "blob", mode: "100644", sha: "unapproved" }]
      : []),
  ];
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const pathname = url.pathname;
    let json;
    if (pathname.endsWith("/pulls")) {
      json = [
        {
          number: 7,
          state: "closed",
          merged: true,
          merge_commit_sha: "merge",
          merged_at: "2026-09-01T00:00:00Z",
          head: {
            sha: "head",
            ref: "rule/1-2-from-42",
            label: "acme:rule/1-2-from-42",
            repo: { full_name: "acme/feed" },
          },
          base: { ref: "main" },
        },
      ];
    } else if (pathname.endsWith("/git/ref/heads/main")) {
      json = { object: { sha: "base" } };
    } else if (pathname.endsWith("/git/blobs")) {
      json = { sha: "frozen-rule" };
    } else if (pathname.endsWith("/git/commits/base")) {
      json = { tree: { sha: "base-tree" } };
    } else if (pathname.endsWith("/git/commits/head")) {
      json = { tree: { sha: "head-tree" } };
    } else if (pathname.endsWith("/git/commits/merge")) {
      json = {
        tree: { sha: "merged-tree" },
        parents: [{ sha: "base-parent" }, { sha: "head" }],
      };
    } else if (pathname.endsWith("/git/commits/base-parent")) {
      json = { tree: { sha: "base-parent-tree" } };
    } else if (pathname.endsWith("/pulls/7/commits")) {
      json = [{ sha: "head" }];
    } else if (pathname.endsWith("/commits/head")) {
      json = {
        files: [
          { filename: "rules/1-1.md" },
          ...(extraFile ? [{ filename: "README.md" }] : []),
        ],
      };
    } else if (pathname.includes("/compare/")) {
      json = pathname.includes("/compare/merge...main")
        ? { status: "ahead" }
        : { merge_base_commit: { sha: "merge-base" } };
    } else if (pathname.endsWith("/git/commits/merge-base")) {
      json = { tree: { sha: "merge-base-tree" } };
    } else if (pathname.endsWith("/git/trees/base-tree")) {
      json = { tree: baseEntries, truncated: false };
    } else if (pathname.endsWith("/git/trees/head-tree")) {
      json = { tree: headEntries, truncated: false };
    } else if (pathname.endsWith("/git/trees/merged-tree")) {
      json = { tree: mergeEntries, truncated: false };
    } else if (pathname.endsWith("/git/trees/base-parent-tree")) {
      json = {
        tree: [{ path: "rules/1-1.md", type: "blob", mode: "100644", sha: "old-rule" }],
        truncated: false,
      };
    } else if (pathname.endsWith("/git/trees/merge-base-tree")) {
      json = { tree: [{ path: "rules/1-1.md", type: "blob", mode: "100644", sha: "old-rule" }], truncated: false };
    } else {
      throw new Error(`Unexpected request ${init.method || "GET"} ${rawUrl}`);
    }
    return { ok: true, status: 200, json: async () => json };
  };
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("merged PR recovery validates frozen contents and rejects extra changes", async () => {
  const request = {
    branch: "rule/1-2-from-42",
    base: "main",
    path: "rules/1-1.md",
    content: "Include official model announcements.",
    title: "Update rule 1-1",
    owner: "acme",
    repo: "feed",
  };
  await withMergedPrApi({}, async () => {
    const pr = await upsertFilePr(request);
    assert.equal(pr.number, 7);
  });
  await withMergedPrApi({ baseRuleSha: "later-amendment" }, async () => {
    const pr = await upsertFilePr(request);
    assert.equal(pr.number, 7, "later changes on main do not invalidate the original merge");
  });
  await withMergedPrApi({ mergeRuleSha: "different-content" }, async () => {
    await assert.rejects(() => upsertFilePr(request), /merge commit .* did not apply/);
  });
  await withMergedPrApi({ headRuleSha: "different-content" }, async () => {
    await assert.rejects(() => upsertFilePr(request), /head does not match the frozen rule content/);
  });
  await withMergedPrApi({ extraFile: true }, async () => {
    await assert.rejects(() => upsertFilePr(request), /contains changes outside the frozen rule content/);
  });
});

test("merged PR recovery rejects extra paths after the PR head is the merge base", async () => {
  const request = {
    branch: "rule/1-2-from-42",
    base: "main",
    path: "rules/1-1.md",
    content: "Include official model announcements.",
    title: "Update rule 1-1",
    owner: "acme",
    repo: "feed",
  };
  await withMergedPrApi({ extraFile: true }, async () => {
    await assert.rejects(
      () => upsertFilePr(request),
      /contains changes outside the frozen rule content/,
    );
  });
});

test("merged PR recovery validates the merge result against its actual base parent", async () => {
  const request = {
    branch: "rule/1-2-from-42",
    base: "main",
    path: "rules/1-1.md",
    content: "Include official model announcements.",
    title: "Update rule 1-1",
    owner: "acme",
    repo: "feed",
  };
  await withMergedPrApi({ extraMergedFile: true }, async () => {
    await assert.rejects(
      () => upsertFilePr(request),
      /contains changes outside the frozen rule content/,
    );
  });
});

test("commit reachability check accepts only a target ref containing the merge commit", async () => {
  const originalFetch = globalThis.fetch;
  let requestedPath = null;
  globalThis.fetch = async (rawUrl) => {
    requestedPath = new URL(rawUrl).pathname;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "ahead" }),
    };
  };
  try {
    assert.equal(await isCommitReachableFromRef("merge-sha", "main"), true);
    assert.equal(requestedPath, "/repos/acme/feed/compare/merge-sha...main");
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "identical" }),
    });
    assert.equal(await isCommitReachableFromRef("merge-sha", "main"), true);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "behind" }),
    });
    assert.equal(await isCommitReachableFromRef("merge-sha", "main"), false);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "diverged" }),
    });
    assert.equal(await isCommitReachableFromRef("merge-sha", "main"), false);
    assert.equal(await isCommitReachableFromRef(null, "main"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
