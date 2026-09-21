import test from "node:test";
import assert from "node:assert/strict";
import Parser from "rss-parser";
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

test("sanitizeRssXml leaves CDATA ampersands intact", () => {
  const xml = "<item><title><![CDATA[OpenAI & Anthropic]]></title></item>";
  assert.equal(sanitizeRssXml(xml), xml);
});

test("sanitizeRssXml preserves uppercase hex entities", () => {
  const ok = "<title>Quote &#X2019; here</title>";
  assert.equal(sanitizeRssXml(ok), ok);
});

test("sanitizeRssXml mixed document: escape outside CDATA only", () => {
  const mixed =
    "<r><a>Tom & Jerry</a><b><![CDATA[Sam & Max]]></b></r>";
  assert.equal(
    sanitizeRssXml(mixed),
    "<r><a>Tom &amp; Jerry</a><b><![CDATA[Sam & Max]]></b></r>",
  );
});

test("sanitizeRssXml makes bare-& RSS parseable", async () => {
  const parser = new Parser();
  const fixture = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>Manufacturing & Engineering AI</title><link>https://e.com/p?utm_source=AI-News&utm_medium=x</link><pubDate>Mon, 21 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  let rawRejected = false;
  try {
    await parser.parseString(fixture);
  } catch (e) {
    rawRejected = /entity/i.test(String(e?.message || e));
  }
  const parsed = await parser.parseString(sanitizeRssXml(fixture));
  assert.equal(parsed.items[0].title, "Manufacturing & Engineering AI");
  assert.match(parsed.items[0].link, /utm_source=AI-News&utm_medium=x/);
  // Prefer reject-on-raw when the parser surfaces the entity error
  if (!rawRejected) {
    console.log("note: raw fixture did not reject; sanitized parse still correct");
  }
});
