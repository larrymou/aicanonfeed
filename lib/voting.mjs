export function isBot(login) {
  return /\[bot\]$/i.test(login || "");
}

/** Unique accounts whose reactions can affect the public vote tally. */
export function accountAgeVoteLogins(reactions, authorLogin) {
  const author = String(authorLogin || "").toLowerCase();
  return [
    ...new Set(
      (reactions || [])
        .filter((reaction) => reaction.content === "+1" || reaction.content === "-1")
        .map((reaction) => reaction.user?.login)
        .filter(
          (login) =>
            login &&
            login.toLowerCase() !== author &&
            !isBot(login),
        ),
    ),
  ];
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
 * Account-age gate (minAccountAgeDays > 0) runs once per login after merging
 * both reactions, so a dual +1/−1 vote cannot collapse into a single side
 * when one reaction object carries created_at and the other does not.
 * - confirmed too young  → droppedYoung (not counted)
 * - not_found / missing createdAt → droppedUnknown (not counted, fail-closed)
 * - lookup_failed (API/timeout) → lookupFailed (not counted, but caller must
 *   NOT settle irreversibly — eligibility is unknown, not denied)
 * getCreatedAt(login) may return a string, null, or { ok, createdAt, reason }.
 */
export function tallyVotes(reactions, authorLogin, opts = {}) {
  const { minAccountAgeDays = 0, now = Date.now(), getCreatedAt } = opts;
  const byUser = new Map();
  const author = String(authorLogin || "").toLowerCase();
  for (const r of reactions || []) {
    if (r.content !== "+1" && r.content !== "-1") continue;
    const login = r.user?.login;
    if (!login) continue;
    if (login.toLowerCase() === author) continue;
    if (isBot(login)) continue;
    if (!byUser.has(login)) byUser.set(login, { contents: new Set(), createdAt: null });
    const entry = byUser.get(login);
    entry.contents.add(r.content);
    if (!entry.createdAt && r.user?.created_at) entry.createdAt = r.user.created_at;
  }
  const droppedYoung = new Set();
  const droppedUnknown = new Set();
  const lookupFailed = new Set();
  const eligible = new Map();
  for (const [login, entry] of byUser) {
    if (minAccountAgeDays <= 0) {
      eligible.set(login, entry.contents);
      continue;
    }
    let createdAt = entry.createdAt;
    let ok = Boolean(createdAt);
    let reason = null;
    if (!createdAt && getCreatedAt) {
      const res = getCreatedAt(login);
      if (res && typeof res === "object" && "ok" in res) {
        ok = Boolean(res.ok) && Boolean(res.createdAt);
        createdAt = res.createdAt || null;
        reason = res.reason || null;
      } else {
        createdAt = res || null;
        ok = Boolean(createdAt);
      }
    }
    if (!ok || !createdAt) {
      if (reason === "lookup_failed") lookupFailed.add(login);
      else droppedUnknown.add(login);
      continue;
    }
    if (!isAccountOldEnough(createdAt, minAccountAgeDays, now)) {
      droppedYoung.add(login);
      continue;
    }
    eligible.set(login, entry.contents);
  }
  let up = 0;
  let down = 0;
  let voided = 0;
  const detail = [];
  for (const [login, set] of eligible) {
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
    lookupFailed: lookupFailed.size,
    dropped: [
      ...[...droppedYoung].map((login) => ({ login, reason: "young" })),
      ...[...droppedUnknown].map((login) => ({ login, reason: "unknown" })),
      ...[...lookupFailed].map((login) => ({ login, reason: "lookup_failed" })),
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

/** Drop reactions created after the frozen vote deadline (if any). */
export function filterReactionsByDeadline(reactions, voteDeadlineAt) {
  if (!voteDeadlineAt) return reactions || [];
  const cutoff = Date.parse(voteDeadlineAt);
  if (!Number.isFinite(cutoff)) return reactions || [];
  return (reactions || []).filter((r) => {
    const created = Date.parse(r.created_at || r.createdAt || "");
    // Missing timestamp: keep (do not drop possibly-valid votes).
    if (!Number.isFinite(created)) return true;
    return created <= cutoff;
  });
}

/**
 * Drop reactions outside the voting window `[startAt, endAt]`.
 * Missing timestamps are kept (same fail-open as the deadline filter).
 * A cleared window (both null) keeps everything.
 */
export function filterReactionsByWindow(reactions, { startAt = null, endAt = null } = {}) {
  return filterReactionsByDeadline(filterReactionsByStart(reactions, startAt), endAt);
}

/**
 * Read a settle-reactions-* record. Accepts either a bare array (legacy) or
 * the `{ reactions: [...] }` envelope written by settle — never treat the
 * envelope object itself as the reaction list.
 */
export function extractReactionList(rec) {
  if (Array.isArray(rec)) return rec;
  const list = rec?.reactions;
  return Array.isArray(list) ? list : null;
}

function filterReactionsByStart(reactions, startAt) {
  if (!startAt) return reactions || [];
  const floor = Date.parse(startAt);
  if (!Number.isFinite(floor)) return reactions || [];
  return (reactions || []).filter((r) => {
    const created = Date.parse(r.created_at || r.createdAt || "");
    if (!Number.isFinite(created)) return true;
    return created >= floor;
  });
}

/**
 * Resolve the effective vote deadline from decision records.
 * Records are consulted oldest→newest; a `voteDeadlineReset` newer than any
 * deadline clears it (re-opened voting window). Returns ISO string or null.
 */
export function pickVoteDeadlineAt(records) {
  let deadline = null;
  for (const rec of records || []) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.voteDeadlineReset) {
      deadline = null;
      continue;
    }
    if (rec.voteDeadlineAt) deadline = rec.voteDeadlineAt;
  }
  return deadline;
}

/**
 * Resolve the voting window from decision records.
 * `voteWindowStartAt` freezes when the proposal entered voting; a
 * `voteDeadlineReset` clears both bounds so a re-open gets a fresh window.
 */
export function pickVoteWindow(records) {
  let startAt = null;
  let endAt = null;
  for (const rec of records || []) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.voteDeadlineReset) {
      // A reset that carries a new window start re-opens voting at that instant.
      startAt = rec.voteWindowStartAt || null;
      endAt = null;
      continue;
    }
    if (rec.voteWindowStartAt) startAt = rec.voteWindowStartAt;
    if (rec.voteDeadlineAt) endAt = rec.voteDeadlineAt;
  }
  return { startAt, endAt: endAt || pickVoteDeadlineAt(records) };
}

/**
 * True when the issue body is a rule proposal (quota applies).
 * Ordinary feedback/bug issues must not consume the daily rule-proposal budget.
 */
export function isRuleProposalBody(body) {
  return /##\s*Proposal Type/i.test(String(body || ""));
}

/**
 * Stable "this filing counts toward the proposal quota" check.
 * Live body alone is not enough — an author can strip `## Proposal Type` from
 * an already-filed same-day proposal to uncount it. Process labels mean the
 * issue entered (or completed) the governance pipeline and stay put after a
 * body edit.
 */
export function countsTowardProposalQuota({ body, labels = [], processLabels = [] } = {}) {
  if (isRuleProposalBody(body)) return true;
  const names = (labels || [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean)
    .map((n) => String(n).toLowerCase());
  const process = new Set(
    (processLabels.length
      ? processLabels
      : [
          "proposal",
          "voting",
          "rejected",
          "ratified",
          "ratified_pending_merge",
          "defeated",
          "expired_no_quorum",
        ]
    ).map((n) => String(n).toLowerCase()),
  );
  return names.some((n) => process.has(n));
}

/**
 * A terminal label may be closed only when a frozen record backs it.
 * `settle` is a settlement-* record; `pre` is a pre-review-* record.
 */
export function hasFrozenTerminal(settle, pre) {
  if (settle?.outcome) return true;
  return Boolean(pre?.verdict === "reject");
}

/**
 * Disposition when a settle target (rule/group) is missing or only known from
 * a stale checkout. `rulesFresh` means local checkout is known to match origin.
 * A miss on a stale checkout must not become an irreversible reject; a hit on a
 * stale checkout is a stale positive (status/category may already differ) and
 * must not become an irreversible reject or ratify.
 */
export function missingTargetDisposition({ rulesFresh = true, found = false } = {}) {
  if (rulesFresh) return found ? "ok" : "reject";
  return "defer";
}

/**
 * Walk decision records oldest→newest and report whether the latest settle
 * state is a defer (lookup incomplete / rules stale). A later non-defer
 * settlement supersedes the flag.
 */
export function latestSettleDeferred(records) {
  let deferred = false;
  for (const rec of records || []) {
    if (!rec || typeof rec !== "object") continue;
    const o = rec.outcome;
    if (!o) continue;
    if (o === "needs_manual" || String(o).startsWith("deferred")) {
      deferred = true;
    } else {
      deferred = false;
    }
  }
  return deferred;
}

/**
 * Deferred flag scoped to the current voting window.
 * A `voteDeadlineReset` starts a new window — older settle-deferred records
 * must not keep the UI (or callers) in a stale deferred state.
 */
export function latestSettleDeferredInWindow(records) {
  let deferred = false;
  for (const rec of records || []) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.voteDeadlineReset) {
      deferred = false;
      continue;
    }
    const o = rec.outcome;
    if (!o) continue;
    if (o === "needs_manual" || String(o).startsWith("deferred")) {
      deferred = true;
    } else {
      deferred = false;
    }
  }
  return deferred;
}

/** Sort heterogeneous decision records by their event time, not filename prefix. */
export function sortDecisionRecordsByEventTime(records) {
  const eventTime = (record) => {
    for (const key of ["resetAt", "deferredAt", "settledAt", "frozenAt", "capturedAt", "at"]) {
      const value = Date.parse(String(record?.[key] || ""));
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  return [...(records || [])].sort((a, b) => {
    const aTime = eventTime(a);
    const bTime = eventTime(b);
    if (aTime == null && bTime == null) return 0;
    if (aTime == null) return -1;
    if (bTime == null) return 1;
    return aTime - bTime;
  });
}

/**
 * Latest frozen pre-review verdict among decision records (newest first).
 * Ignores `verdict: "error"` tooling records so they cannot shadow a frozen
 * pass/reject and force a re-judge.
 */
export function latestFrozenVerdict(records) {
  for (const rec of [...(records || [])].reverse()) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.verdict === "pass" || rec.verdict === "reject") return rec;
  }
  return null;
}

/**
 * Disposition when a voting/settle snapshot is missing or incomplete.
 * A frozen `pass` with a lost snapshot is tooling failure (defer); otherwise
 * missing snapshot is a possible manual-label bypass (reject).
 */
export function snapshotFreezeDisposition({ hasFrozenPass = false, snapshotComplete = false } = {}) {
  if (snapshotComplete) return "ok";
  return hasFrozenPass ? "defer" : "reject";
}

/**
 * Gate codes from evaluateProposalBody that depend on a fresh on-disk `rules/`
 * checkout (target existence / status / group-category agreement). A miss on a
 * stale checkout must not become an irreversible pre-review reject.
 */
export const RULES_DEPENDENT_GATE_CODES = Object.freeze([
  "target_not_found",
  "target_is_revoked",
  "target_not_active",
  "target_group_not_found",
  "target_group_inactive",
  "category_group_mismatch",
]);

/**
 * Disposition when a pre-review shape gate fails.
 * Pure-shape codes (missing fields, length, unsafe text, …) reject even on a
 * stale checkout. Rules-dependent codes reject only when `rulesFresh`.
 */
export function rulesDependentGateDisposition({ rulesFresh = true, code = "" } = {}) {
  if (!RULES_DEPENDENT_GATE_CODES.includes(String(code || ""))) {
    return "reject";
  }
  return rulesFresh ? "reject" : "defer";
}

/**
 * True when a frozen pre-review `pass` record embeds enough snapshot fields to
 * rebuild a lost `decisions/rule-snapshots/<n>.json` without re-parsing the
 * (possibly edited) issue body. Only `rec.snapshot` is trusted — top-level
 * decision fields never carry ruleText.
 */
export function snapshotRebuildableFrom(rec) {
  const src = rec?.snapshot;
  return Boolean(src && src.proposalType && src.ruleText);
}

/**
 * Validate a pre-review model JSON payload. Only explicit `pass` / `reject`
 * may freeze a decision; anything else is a tooling error (retry), never a
 * permanent reject.
 */
export function normalizeModelVerdict(raw) {
  const v = String(raw?.verdict ?? "")
    .toLowerCase()
    .trim();
  if (v === "pass") return { ok: true, verdict: "pass", reason: raw?.reason ?? "" };
  if (v === "reject") return { ok: true, verdict: "reject", reason: raw?.reason ?? "" };
  return {
    ok: false,
    verdict: null,
    error: `unexpected verdict: ${v || "(empty)"}`,
    reason: raw?.reason ?? "",
  };
}

/**
 * Validate a content-moderation model JSON payload.
 * `include` must be an explicit boolean; anything else is invalid tooling
 * output and must not write a permanent content decision / seen-hash.
 * When `include` is true, a missing/unknown `matchedRuleId` is also a protocol
 * error (retry), not a grounded content reject.
 */
export function normalizeContentVerdict(raw, { knownRuleIds = null } = {}) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "empty model response" };
  }
  if (typeof raw.include !== "boolean") {
    return {
      ok: false,
      error: `unexpected include: ${JSON.stringify(raw.include ?? null)}`,
    };
  }
  if (raw.include === true && knownRuleIds) {
    const id = raw.matchedRuleId == null ? "" : String(raw.matchedRuleId);
    if (!id || !knownRuleIds.has(id)) {
      return {
        ok: false,
        error: `include=true with invalid matchedRuleId: ${id || "(empty)"}`,
      };
    }
  }
  return { ok: true, include: raw.include };
}

/**
 * True when a pull request is the one frozen in settlement records.
 * Requires matching number, same-repo head/base repositories, and the frozen
 * refs when supplied. `headLabel` is `owner:branch` when available.
 */
export function prMatchesFrozenIdentity(
  pr,
  {
    expectedNumber = null,
    baseOwner = null,
    baseRepo = null,
    expectedHeadRef = null,
    expectedBaseRef = null,
  } = {},
) {
  if (!pr || typeof pr !== "object") return false;
  if (expectedNumber != null && Number(pr.number) !== Number(expectedNumber)) {
    return false;
  }
  if (expectedHeadRef != null && pr.head?.ref !== expectedHeadRef) return false;
  if (expectedBaseRef != null && pr.base?.ref !== expectedBaseRef) return false;
  const headRepo = pr.head?.repo?.full_name ||
    (pr.head?.repo?.owner?.login && pr.head?.repo?.name
      ? `${pr.head.repo.owner.login}/${pr.head.repo.name}`
      : null);
  const headLabel = pr.head?.label || "";
  const baseFullName = pr.base?.repo?.full_name ||
    (pr.base?.repo?.owner?.login && pr.base?.repo?.name
      ? `${pr.base.repo.owner.login}/${pr.base.repo.name}`
      : null);
  if (baseOwner && baseRepo) {
    const expected = `${baseOwner}/${baseRepo}`.toLowerCase();
    if (!headRepo || headRepo.toLowerCase() !== expected) return false;
    if (!baseFullName || baseFullName.toLowerCase() !== expected) return false;
    if (headLabel && headLabel.toLowerCase() !== `${baseOwner}:${pr.head?.ref || ""}`.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * True when the PR head still matches the SHA frozen at acceptance/create.
 * `expectedSha == null` (legacy record) returns false so callers must decide;
 * never silently treat "unknown SHA" as "content unchanged".
 */
export function prHeadMatchesFrozen(pr, expectedSha) {
  if (!expectedSha) return false;
  return Boolean(pr?.head?.sha) && pr.head.sha === expectedSha;
}
