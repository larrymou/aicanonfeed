/**
 * Linked-page facts for evidence — HTML-only, no third-party reader.
 *
 * Observes only:
 * - linked_page_owner_domain  (final URL host after redirects)
 * - linked_page_author        (meta author, if present)
 *
 * Does NOT observe page body content or version labels (kept unobserved).
 * Never throws; callers treat { ok: false, reason } as "fact still unobserved".
 *
 * SSRF guard: only public http(s) hosts; private/loopback/link-local/metadata
 * addresses are rejected before any request (and after each redirect hop).
 */

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BYTES = 256_000;
const MAX_AUTHOR_CHARS = 120;
const MAX_REDIRECTS = 5;

const CONTENT_RE = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i;

/** True when the hostname must never be fetched (SSRF / local). */
export function isBlockedHostname(hostname) {
  const h = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "0.0.0.0" ||
    h === "metadata.google.internal" ||
    h === "metadata" ||
    h.endsWith(".metadata.google.internal")
  ) {
    return true;
  }

  // IPv4 literal
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }

  // IPv6 literals / zone ids
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^(?:fe80|fc|fd|ff)/i.test(h)) return true;
    const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mapped) return isBlockedHostname(mapped[1]);
    return true; // conservative: bare IPv6 not clearly public
  }

  return false;
}

function isBlockedUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    return isBlockedHostname(u.hostname);
  } catch {
    return true;
  }
}

/** Heuristic: body looks like an HTML document (not JSON/binary/empty). */
function looksLikeHtml(body) {
  // Scan a wider window than author extraction so long comments/prologs
  // before <html> are not false-negatives.
  let head = String(body || "").slice(0, 24_000).replace(/^\uFEFF/, "").trimStart();
  for (;;) {
    const xml = head.match(/^<\?xml[\s\S]*?\?>/i);
    if (xml) {
      head = head.slice(xml[0].length).trimStart();
      continue;
    }
    if (head.startsWith("<!--")) {
      const end = head.indexOf("-->");
      if (end === -1) return false;
      head = head.slice(end + 3).trimStart();
      continue;
    }
    break;
  }
  return (
    /^<(!doctype\s+html|html|head|meta|title|body)\b/i.test(head) ||
    /<html[\s>]/i.test(head)
  );
}

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
    if (isBlockedHostname(u.hostname)) {
      out.reason = "blocked-host";
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
  if (!looksLikeHtml(body)) {
    out.reason = "not_html";
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
  // Local /g regex so lastIndex cannot race across concurrent calls.
  const head = html.slice(0, 24_000);
  const re = /<meta\b[^>]*\b(?:name|property|itemprop)\s*=\s*["'](?:author|article:author|byl|dc\.creator)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(head)) !== null) {
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
 * GET `url` and parse page facts. Follows redirects only across public hosts.
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

  let current;
  try {
    current = new URL(String(url || ""));
  } catch {
    return { ...base, reason: "invalid-url" };
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    return { ...base, reason: "invalid-url" };
  }
  if (isBlockedHostname(current.hostname)) {
    return { ...base, reason: "blocked-host" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (isBlockedHostname(current.hostname)) {
        return { ...base, reason: "blocked-host" };
      }
      res = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
          "user-agent": "aicanonfeed-page-facts/0.1 (+github.com/larrymou/aicanonfeed)",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ...base, reason: "redirect_missing_location" };
        // drain body so the socket can be reused
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        let next;
        try {
          next = new URL(loc, current.toString());
        } catch {
          return { ...base, reason: "redirect_invalid" };
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return { ...base, reason: "redirect_invalid" };
        }
        current = next;
        continue;
      }
      break;
    }
    if (!res) return { ...base, reason: "fetch_failed" };
    if (res.status >= 300 && res.status < 400) {
      return { ...base, reason: "too_many_redirects" };
    }
    if (!res.ok) {
      return { ...base, reason: `http_${res.status}` };
    }
    const type = String(res.headers.get("content-type") || "");
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) {
      return { ...base, reason: "not_html" };
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return { ...base, reason: "too_large" };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { ...base, reason: "too_large" };
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    // Empty/missing content-type still must look like HTML (sniff in parsePageFacts).
    const facts = parsePageFacts(html, current.toString());
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
