import test from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN = "test-token";

const { resolveUserCreatedAts } = await import("../lib/github.mjs");

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

test("account-age lookups deduplicate logins and honor a concurrency bound", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response(200, { created_at: "2020-01-01T00:00:00Z" });
  };
  try {
    const logins = Array.from({ length: 20 }, (_, i) => `user-${i}`);
    logins.push("user-0");
    const result = await resolveUserCreatedAts(logins, {
      concurrency: 4,
      timeoutMs: 2_000,
    });
    assert.equal(result.size, 20);
    assert.equal(maxActive, 4);
    assert.equal(result.get("user-0").ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("account-age lookups stop at the shared deadline and remain unknown", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(200, { created_at: "2020-01-01" })), 1_000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("request aborted"));
        },
        { once: true },
      );
    });
  try {
    const startedAt = Date.now();
    const result = await resolveUserCreatedAts(
      Array.from({ length: 12 }, (_, i) => `slow-${i}`),
      { concurrency: 3, timeoutMs: 30 },
    );
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(result.size, 12);
    for (const entry of result.values()) {
      assert.equal(entry.ok, false);
      assert.equal(entry.reason, "lookup_failed");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
