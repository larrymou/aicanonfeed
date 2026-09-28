/** Static checks on community rule text before it enters the moderation prompt. */

/**
 * Prompt-injection patterns only. Community rule text is legislation — specific
 * inclusion criteria ("Always include every official model announcement…",
 * "Never reject items that link to…", papers about "jailbreak" attacks) must
 * pass. Flag only unqualified absolute include-all / never-reject phrasing.
 */
const FORBIDDEN = [
  { re: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts)/i, label: "ignore-previous" },
  { re: /disregard\s+(all|any|the)\s+(other\s+)?rules/i, label: "disregard-rules" },
  { re: /you\s+are\s+now\s+(a|an|the)\b/i, label: "role-hijack" },
  // Topical words like "jailbreak" / "system prompt" appear in legitimate
  // research rules; only match injection-shaped phrases.
  { re: /\b(enter|enable|activate|switch\s+to)\s+(jailbreak|dan\s+mode)\b/i, label: "jailbreak" },
  { re: /\bjailbreak\s+mode\b/i, label: "jailbreak" },
  { re: /\bdan\s+mode\b/i, label: "jailbreak" },
  { re: /ignore\s+(the\s+|your\s+)?system\s+prompt\b/i, label: "jailbreak" },
  // Unqualified "always include every/all <generic>" — not scoped criteria.
  {
    re: /always\s+include\s+(?:every|all)\s+(?:item|items|content|post|posts|entry|entries|thing|things|submission|submissions|input|inputs|text|article|articles|story|stories|example|examples|response|responses|output|outputs|tweet|tweets|message|messages)\b(?!\s*(?:that|which|whose|from|on|in|with|because|if|when|unless|linking|for|as|by)\b)/i,
    label: "always-include-all",
  },
  { re: /always\s+include\s+(?:everything|anything)\b/i, label: "always-include-all" },
  { re: /always\s+include\s+(?:every|all)\s*[.!?]?\s*$/i, label: "always-include-all" },
  // Unqualified "never reject <generic>" — not "never reject X that links to…".
  {
    re: /never\s+reject\s+(?:any\s+|all\s+|every\s+)?(?:item|items|content|post|posts|entry|entries|thing|things|submission|submissions|input|inputs|text|article|articles|story|stories|example|examples|response|responses|output|outputs|tweet|tweets|message|messages)\b(?!\s*(?:that|which|whose|from|on|in|with|because|if|when|unless|linking|for|as|by)\b)/i,
    label: "never-reject",
  },
  { re: /never\s+reject\s+(?:anything|everything)\b/i, label: "never-reject" },
  { re: /never\s+reject\s*[.!?]?\s*$/i, label: "never-reject" },
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
