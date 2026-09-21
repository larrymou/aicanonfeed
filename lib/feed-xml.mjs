/**
 * Fetch RSS/XML ourselves so we can repair common malformations
 * before rss-parser/sax (Invalid character in entity name).
 */

const DEFAULT_UA = "AICanonFeed/0.1 (+https://github.com/larrymou/aicanonfeed)";

/** Escape & that are not already a valid XML entity reference. */
export function sanitizeRssXml(xml) {
  return String(xml ?? "").replace(
    /&(?!#\d{1,7};|#x[0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,7};)/g,
    "&amp;",
  );
}

export async function fetchFeedText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 25000;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`feed timeout: ${url}`)), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": userAgent, accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}: ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
