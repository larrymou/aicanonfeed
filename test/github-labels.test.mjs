import test from "node:test";
import assert from "node:assert/strict";

// Mock env + fetch before importing the module under test.
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "acme/feed";

const calls = [];
const responses = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method || "GET", body: init.body });
  // Authenticated viewer identity for commentOnce dedupe.
  if (u.endsWith("/user") && !u.includes("/users/")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ login: "github-actions[bot]" }),
    };
  }
  const next = responses.length ? responses.shift() : { status: 200, json: [] };
  if (next.throwAfterCreate && init.method === "POST") {
    throw new Error("connection lost after request delivery");
  }
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    json: async () => next.json,
  };
};

const { removeLabels, setLabels, commentOnce } = await import("../lib/github.mjs");

test("commentOnce finds a delivered marker before retrying a comment", async () => {
  calls.length = 0;
  responses.length = 0;
  const marker = "<!-- settle:42:ratified:run-1 -->";
  responses.push({ status: 200, json: [] });
  responses.push({ status: 201, json: { id: 1 } });
  responses.push({
    status: 200,
    json: [{ user: { login: "github-actions[bot]" }, body: `result\n\n${marker}` }],
  });

  assert.deepEqual(await commentOnce(42, marker, "Settlement result"), { created: true });
  assert.deepEqual(await commentOnce(42, marker, "Settlement result"), { created: false });
  // GET comments → GET /user (cached after) → POST → GET comments
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET", "POST", "GET"],
  );
  assert.match(JSON.parse(calls[2].body).body, /settle:42:ratified:run-1/);
});

test("commentOnce does not trust a marker posted by another user", async () => {
  calls.length = 0;
  responses.length = 0;
  const marker = "<!-- settle:42:ratified:run-2 -->";
  responses.push({
    status: 200,
    json: [{ user: { login: "proposal-author" }, body: marker }],
  });
  responses.push({ status: 201, json: { id: 2 } });

  assert.deepEqual(await commentOnce(42, marker, "Settlement result"), { created: true });
  const methods = calls.map((call) => call.method);
  assert.equal(methods.filter((m) => m === "POST").length, 1);
  assert.ok(methods.includes("GET"));
});

test("commentOnce can recover when a delivered post response is lost", async () => {
  calls.length = 0;
  responses.length = 0;
  const marker = "<!-- settle:42:ratified:run-lost-response -->";
  responses.push({ status: 200, json: [] });
  responses.push({ throwAfterCreate: true });
  responses.push({
    status: 200,
    json: [{ user: { login: "github-actions[bot]" }, body: `result\n\n${marker}` }],
  });

  await assert.rejects(
    () => commentOnce(42, marker, "Settlement result"),
    /connection lost/,
  );
  assert.deepEqual(
    await commentOnce(42, marker, "Settlement result"),
    { created: false },
  );
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
});

test("removeLabels throws on non-404 failure", async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({ status: 500, json: {} });
  await assert.rejects(
    () => removeLabels(1, ["voting"]),
    /removeLabels failed/,
  );
});

test("removeLabels ignores 404 (already gone)", async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({ status: 404, json: {} });
  await removeLabels(1, ["voting"]);
  assert.equal(calls.length, 1);
});

test("setLabels throws when GET fails (no dual-queue fallback)", async () => {
  calls.length = 0;
  responses.length = 0;
  // GET labels fails → must throw, must NOT add-then-remove
  responses.push({ status: 500, json: {} });
  await assert.rejects(
    () => setLabels(1, ["ratified"], ["voting"]),
    /cannot read current labels/,
  );
  const methods = calls.map((c) => c.method);
  assert.ok(!methods.includes("POST"), `no add fallback, got ${methods.join(",")}`);
  assert.ok(!methods.includes("DELETE"), `no remove fallback, got ${methods.join(",")}`);
});

test("setLabels rolls back added labels when removing old labels fails", async () => {
  calls.length = 0;
  responses.length = 0;
  // Read current labels, add target state, then fail while removing old state.
  responses.push({ status: 200, json: [{ name: "voting" }] });
  responses.push({ status: 200, json: [{ name: "ratified" }] });
  responses.push({ status: 500, json: {} });
  // Compensation restores voting and removes the newly-added ratified label.
  responses.push({ status: 200, json: [{ name: "voting" }] });
  responses.push({ status: 200, json: [] });
  await assert.rejects(() => setLabels(1, ["ratified"], ["voting"]));
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "DELETE", "POST", "DELETE"]);
  assert.deepEqual(JSON.parse(calls[1].body).labels, ["ratified"]);
  assert.deepEqual(JSON.parse(calls[3].body).labels, ["voting"]);
  assert.ok(calls[4].url.endsWith("/labels/ratified"));
});

test("setLabels changes only requested labels and preserves unrelated labels", async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({ status: 200, json: [{ name: "voting" }, { name: "custom" }] });
  responses.push({ status: 200, json: [{ name: "ratified" }, { name: "custom" }] });
  responses.push({ status: 200, json: [] });
  await setLabels(1, ["ratified"], ["voting"]);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "DELETE"]);
  assert.deepEqual(JSON.parse(calls[1].body).labels, ["ratified"]);
  assert.ok(calls[2].url.endsWith("/labels/voting"));
  assert.ok(!calls.some((c) => c.method === "PUT"));
});
