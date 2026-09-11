import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function urlHash(url) {
  const normalized = String(url || "")
    .trim()
    .toLowerCase()
    .replace(/#.*$/, "");
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

export function appendIndex(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map((r) => JSON.stringify(r)).join("\n");
  fs.appendFileSync(file, lines + (rows.length ? "\n" : ""), "utf8");
}
