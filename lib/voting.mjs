export function isBot(login) {
  return /\[bot\]$/i.test(login || "");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Account must be at least minDays old. Missing/invalid createdAt → not eligible. */
export function isAccountOldEnough(createdAt, minDays, now = Date.now()) {
  const min = Number(minDays) || 0;
  if (min <= 0) return true;
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return now - t >= min * DAY_MS;
}

/**
 * Tally GitHub issue reactions.
 * Author is excluded from the public tally (spec).
 * Account-age gate (minAccountAgeDays > 0):
 * - confirmed too young  → droppedYoung (not counted)
 * - unknown createdAt / lookup failed → droppedUnknown (not counted, fail-closed)
 * getCreatedAt(login) may return a string, null, or { ok, createdAt }.
 */
export function tallyVotes(reactions, authorLogin, opts = {}) {
  const { minAccountAgeDays = 0, now = Date.now(), getCreatedAt } = opts;
  const byUser = new Map();
  const droppedYoung = new Set();
  const droppedUnknown = new Set();
  for (const r of reactions || []) {
    const login = r.user?.login;
    const content = r.content;
    if (!login) continue;
    if (login.toLowerCase() === String(authorLogin || "").toLowerCase()) continue;
    if (isBot(login)) continue;
    if (minAccountAgeDays > 0) {
      let createdAt = r.user?.created_at || null;
      let ok = Boolean(createdAt);
      if (!createdAt && getCreatedAt) {
        const res = getCreatedAt(login);
        if (res && typeof res === "object" && "ok" in res) {
          ok = Boolean(res.ok) && Boolean(res.createdAt);
          createdAt = res.createdAt || null;
        } else {
          createdAt = res || null;
          ok = Boolean(createdAt);
        }
      }
      if (!ok || !createdAt) {
        droppedUnknown.add(login);
        continue;
      }
      if (!isAccountOldEnough(createdAt, minAccountAgeDays, now)) {
        droppedYoung.add(login);
        continue;
      }
    }
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
  return {
    up,
    down,
    voided,
    valid,
    detail,
    droppedYoung: droppedYoung.size,
    droppedUnknown: droppedUnknown.size,
    dropped: [
      ...[...droppedYoung].map((login) => ({ login, reason: "young" })),
      ...[...droppedUnknown].map((login) => ({ login, reason: "unknown" })),
    ],
  };
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
  const n = Math.max(0, Number(stars) || 0);
  const cap = Math.max(0, Number(ceiling) || 0);
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

/** Quorum counts approve votes only (`up >= quorum`) — opponents cannot meet quorum (no-show paradox). */
export function settleOutcome({ up, down, quorum, founderVote = false }) {
  if (founderVote) return "ratified";
  if (up < quorum) return "expired_no_quorum";
  if (up > down) return "ratified";
  return "defeated";
}
