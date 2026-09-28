/**
 * Fetch RSS/XML ourselves so we can repair common malformations
 * before rss-parser/sax (Invalid character in entity name).
 * Sanitize is a repair layer, not a general XML normalizer — CDATA is left alone.
 */

const DEFAULT_UA = "AICanonFeed/0.1 (+https://github.com/larrymou/aicanonfeed)";
/** Hard ceiling on a single feed body — refuse pathological RSS payloads. */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

/** Escape & that are not already a valid XML entity reference; leave CDATA intact. */
export function sanitizeRssXml(xml) {
  const s = String(xml ?? "");
  return s
    .split(/(<!\[CDATA\[.*?\]\]>)/gs)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(
            /&(?!#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,7};)/g,
            "&amp;",
          ),
    )
    .join("");
}

export async function fetchFeedText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 25000;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const maxBytes = opts.maxBytes ?? MAX_FEED_BYTES;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`feed timeout: ${url}`)), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": userAgent, accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}: ${url}`);
    // Stream and bail as soon as the body exceeds the cap — never buffer a
    // pathological payload just to reject it afterwards.
    if (!res.body || typeof res.body.getReader !== "function") {
      const text = await res.text();
      // Compare bytes (not UTF-16 code units) against the cap.
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        throw new Error(`feed too large (> ${maxBytes} bytes): ${url}`);
      }
      return text;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.length || 0;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(`feed too large (> ${maxBytes} bytes): ${url}`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}
