/** Static checks on community rule text before it enters the moderation prompt. */

const FORBIDDEN = [
  { re: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts)/i, label: "ignore-previous" },
  { re: /disregard\s+(all|any|the)\s+(other\s+)?rules/i, label: "disregard-rules" },
  { re: /you\s+are\s+now\s+(a|an|the)\b/i, label: "role-hijack" },
  { re: /\b(system\s+prompt|jailbreak|dan\s+mode)\b/i, label: "jailbreak" },
  { re: /always\s+include\s+(every|all)\b/i, label: "always-include-all" },
  { re: /never\s+reject\b/i, label: "never-reject" },
  { re: /override\s+(the\s+)?(moderation|editor|meta-?rules)/i, label: "override-moderation" },
];

/**
 * @returns {null | string} reason if unsafe, else null
 */
export function scanRuleText(text) {
  const t = String(text || "");
  if (!t.trim()) return "empty";
  for (const { re, label } of FORBIDDEN) {
    if (re.test(t)) return `forbidden_pattern:${label}`;
  }
  return null;
}
