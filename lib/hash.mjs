import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Strip tracking params and fragment so the same story hashes once. */
export function normalizeUrl(url) {
  const raw = String(url || "").trim();
  try {
    const u = new URL(raw);
    u.hash = "";
    const drop = [];
    for (const [k] of u.searchParams) {
      if (
        /^(utm_|fbclid|gclid|ref_src|ref_url|mc_|igshid)/i.test(k) ||
        k === "ref"
      ) {
        drop.push(k);
      }
    }
    for (const k of drop) u.searchParams.delete(k);
    // Stable query order so ?a=1&b=2 and ?b=2&a=1 hash identically.
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw.replace(/#.*$/, "");
  }
}

export function urlHash(url) {
  const normalized = normalizeUrl(url);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function loadIndexFile(file) {
  const set = new Set();
  if (!fs.existsSync(file)) return set;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj.urlHash) set.add(obj.urlHash);
    } catch {
      /* skip bad lines */
    }
  }
  return set;
}

/** Hashes already decided, from index.jsonl and decision files (crash-safe). */
export function loadSeenHashes(indexFile, contentDir) {
  const seen = loadIndexFile(indexFile);
  if (fs.existsSync(contentDir)) {
    for (const name of fs.readdirSync(contentDir)) {
      if (!name.endsWith(".json")) continue;
      // `${urlHash}-${timestamp}.json` — prefix before the first `-` is the hash.
      // Files without `-` (e.g. error records named `${urlHash}.json`) use the stem.
      const stem = name.slice(0, -".json".length);
      const dash = stem.indexOf("-");
      const hash = dash >= 0 ? stem.slice(0, dash) : stem;
      if (hash) seen.add(hash);
    }
  }
  return seen;
}

/**
 * Claim a URL hash for this run.
 * @returns {null|"already_decided"|"same_run_duplicate"} null = eligible
 */
export function claimUrlHash({ seen, runOccupied, hash }) {
  if (seen.has(hash)) return "already_decided";
  if (runOccupied.has(hash)) return "same_run_duplicate";
  runOccupied.add(hash);
  return null;
}

export function appendIndex(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map((r) => JSON.stringify(r)).join("\n");
  fs.appendFileSync(file, lines + (rows.length ? "\n" : ""), "utf8");
}
