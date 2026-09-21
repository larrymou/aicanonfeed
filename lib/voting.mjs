export function isBot(login) {
  return /\[bot\]$/i.test(login || "");
}

/**
 * Tally GitHub issue reactions.
 * Author is excluded from the public tally (spec).
 */
export function tallyVotes(reactions, authorLogin) {
  const byUser = new Map();
  for (const r of reactions || []) {
    const login = r.user?.login;
    const content = r.content;
    if (!login) continue;
    if (login.toLowerCase() === String(authorLogin || "").toLowerCase()) continue;
    if (isBot(login)) continue;
    if (!byUser.has(login)) byUser.set(login, new Set());
    byUser.get(login).add(content);
  }
  let up = 0;
  let down = 0;
  let voided = 0;
  const detail = [];
  for (const [login, set] of byUser) {
    const hasUp = set.has("+1");
    const hasDown = set.has("-1");
    if (hasUp && hasDown) {
      voided++;
      detail.push({ login, vote: "void" });
      continue;
    }
    if (hasUp) {
      up++;
      detail.push({ login, vote: "up" });
    } else if (hasDown) {
      down++;
      detail.push({ login, vote: "down" });
    }
  }
  const valid = up + down;
  return { up, down, voided, valid, detail };
}

/**
 * F1: founder 👍 while stars < ceiling counts as a casting vote
 * even if that login is the issue author (not in public tally).
 * Founder 👎 or void → no casting vote.
 */
export function applyFounderVote({ stars, reactions, founderLogin, ceiling }) {
  if (!founderLogin) {
    return { founderVote: false, founderLogin: null };
  }
  const n = Number(stars) || 0;
  const cap = Number(ceiling) || 0;
  if (n >= cap) return { founderVote: false, founderLogin: String(founderLogin) };
  const f = String(founderLogin).toLowerCase();
  const mine = (reactions || []).filter(
    (r) => String(r.user?.login || "").toLowerCase() === f,
  );
  if (!mine.length) return { founderVote: false, founderLogin: String(founderLogin) };
  const hasUp = mine.some((r) => r.content === "+1");
  const hasDown = mine.some((r) => r.content === "-1");
  const founderVote = hasUp && !hasDown;
  return { founderVote, founderLogin: String(founderLogin) };
}

export function settleOutcome({ up, down, valid, quorum, founderVote = false }) {
  if (founderVote) return "ratified";
  if (valid < quorum) return "expired_no_quorum";
  if (up > down) return "ratified";
  return "defeated";
}
