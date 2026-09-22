import { createHash } from "node:crypto";

/** Stable fingerprint of the active rule set used for one moderation pass. */
export function rulesFingerprint(rules) {
  const payload = (rules || [])
    .map((r) => `${r.id}|${r.category}|${r.body || r.description || ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
