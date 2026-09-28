/**
 * Linked-page facts for evidence — HTML-only, no third-party reader.
 *
 * Observes only:
 * - linked_page_owner_domain  (final URL host after redirects)
 * - linked_page_author        (meta author, if present)
 *
 * Does NOT observe page body content or version labels (kept unobserved).
 * Never throws; callers treat { ok: false, reason } as "fact still unobserved".
 */

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BYTES = 256_000;
const MAX_AUTHOR_CHARS = 120;

const META_AUTHOR_RE =
  /<meta\b[^>]*\b(?:name|property|itemprop)\s*=\s*["'](?:author|article:author|byl|dc\.creator)["'][^>]*>/gi;
const CONTENT_RE = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i;

/** Pure HTML/URL parse — no network. */
export function parsePageFacts(html, finalUrl) {
  const out = {
    ok: false,
    ownerDomain: null,
    author: null,
    reason: "",
  };

  let host = null;
  try {
    const u = new URL(String(finalUrl || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      out.reason = "invalid-url";
      return out;
    }
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    out.reason = "invalid-url";
    return out;
  }

  const body = String(html || "");
  if (!body.trim()) {
    out.reason = "empty-body";
    return out;
  }

  out.ownerDomain = host;

  const author = extractAuthor(body);
  if (author) out.author = author;

  out.ok = true;
  return out;
}

function extractAuthor(html) {
  // Only scan the head-ish prefix to avoid matching author strings in body copy.
  const head = html.slice(0, 24_000);
  META_AUTHOR_RE.lastIndex = 0;
  let m;
  while ((m = META_AUTHOR_RE.exec(head)) !== null) {
    const tag = m[0];
    const cm = tag.match(CONTENT_RE);
    const raw = cm ? (cm[2] ?? cm[3] ?? "").trim() : "";
    if (!raw) continue;
    // Skip profile URLs (article:author is often a link).
    if (/^https?:\/\//i.test(raw)) continue;
    const cleaned = raw.replace(/\s+/g, " ").slice(0, MAX_AUTHOR_CHARS).trim();
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * GET `url` and parse page facts. Follows redirects; uses final host.
 * @returns {Promise<{ok: boolean, ownerDomain: string|null, author: string|null, reason: string, fetched: boolean}>}
 */
export async function fetchPageFacts(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const base = {
    ok: false,
    ownerDomain: null,
    author: null,
    reason: "",
    fetched: false,
  };

  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return { ...base, reason: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ...base, reason: "invalid-url" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
        "user-agent": "aicanonfeed-page-facts/0.1 (+github.com/larrymou/aicanonfeed)",
      },
    });
    if (!res.ok) {
      return { ...base, reason: `http_${res.status}` };
    }
    const type = String(res.headers.get("content-type") || "");
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) {
      return { ...base, reason: "not_html" };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { ...base, reason: "too_large" };
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const facts = parsePageFacts(html, res.url || parsed.toString());
    return {
      ok: facts.ok,
      ownerDomain: facts.ownerDomain,
      author: facts.author,
      reason: facts.reason,
      fetched: true,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    return { ...base, reason: /abort/i.test(msg) ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}
