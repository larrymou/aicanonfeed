import { createHash } from "node:crypto";

function sha12(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

/** Bump when evidence/repo-link adjudication semantics change. */
export const EVIDENCE_ENGINE_VERSION = "2";

/** Hash of the moderation prompt body actually sent (ignores YAML frontmatter). */
export function promptBodyHash(promptBody) {
  return sha12(String(promptBody || ""));
}

/**
 * Stable fingerprint of the judgment contract:
 * group defs + item rules (id/group/category/body + evidence meta) + final rules
 * context + prompt body + model id + evidence engine version.
 */
export function rulesFingerprint({
  groups = [],
  items = [],
  promptBody = "",
  model = "",
  rulesContext = "",
  evidenceEngineVersion = EVIDENCE_ENGINE_VERSION,
} = {}) {
  const groupPart = (groups || [])
    .map((g) => `${g.id}|${g.category || ""}|${g.name || ""}|${g.body || g.description || ""}`)
    .sort()
    .join("\n");
  const itemPart = (items || [])
    .map((r) => {
      const req = (r.requiresEvidence || r.requires_evidence || [])
        .map((t) => String(t).trim())
        .filter(Boolean)
        .sort()
        .join(",");
      const any = (r.evidenceAny || r.evidence_any || [])
        .map((branch) =>
          (Array.isArray(branch) ? branch : [branch])
            .map((t) => String(t).trim())
            .filter(Boolean)
            .sort()
            .join("+"),
        )
        .sort()
        .join(";");
      return `${r.id}|${r.group || ""}|${r.category || ""}|${r.body || r.description || ""}|req:${req}|any:${any}`;
    })
    .sort()
    .join("\n");
  const payload = [
    `G:${groupPart}`,
    `I:${itemPart}`,
    `C:${rulesContext ? sha12(rulesContext) : ""}`,
    `P:${promptBodyHash(promptBody)}`,
    `M:${String(model || "")}`,
    `E:${String(evidenceEngineVersion || "")}`,
  ].join("\n");
  return sha12(payload);
}
