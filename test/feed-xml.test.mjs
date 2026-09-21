import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeRssXml } from "../lib/feed-xml.mjs";

test("sanitizeRssXml escapes bare ampersands", () => {
  const bad = "<title>Manufacturing & Engineering AI</title>";
  assert.equal(sanitizeRssXml(bad), "<title>Manufacturing &amp; Engineering AI</title>");
});

test("sanitizeRssXml keeps valid entities", () => {
  const ok = '<a href="x?a=1&amp;b=2">&#8217; &#x2019; &lt;ok&gt;</a>';
  assert.equal(sanitizeRssXml(ok), ok);
});

test("sanitizeRssXml handles query-like bare ampersand", () => {
  const bad = "<link>https://example.com/p?utm_source=AI-News&utm_medium=x</link>";
  assert.equal(
    sanitizeRssXml(bad),
    "<link>https://example.com/p?utm_source=AI-News&amp;utm_medium=x</link>",
  );
});

test("sanitizeRssXml is idempotent", () => {
  const once = sanitizeRssXml("A & B");
  assert.equal(sanitizeRssXml(once), once);
});
