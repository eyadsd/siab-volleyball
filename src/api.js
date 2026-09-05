/**
 * Two kinds of key, kept apart on purpose.
 *
 * The admin passcode runs the whole board, so it lives in sessionStorage
 * and dies with the tab. A host passcode runs one game, gets pasted into
 * a group chat anyway, and its owner would be annoyed to re-enter it
 * every time they open the page — so those go in localStorage.
 */
const ADMIN_KEY = "siab.admin";
const HOST_KEYS = "siab.hostkeys";

export const getKey = () => sessionStorage.getItem(ADMIN_KEY) || "";
export const setKey = (k) => sessionStorage.setItem(ADMIN_KEY, k);
export const clearKey = () => sessionStorage.removeItem(ADMIN_KEY);

/** Private-mode browsers throw on storage, and a board that reads is better than one that crashes. */
const readHosts = () => {
  try {
    return JSON.parse(localStorage.getItem(HOST_KEYS) || "{}");
  } catch {
    return {};
  }
};
const writeHosts = (map) => {
  try {
    localStorage.setItem(HOST_KEYS, JSON.stringify(map));
  } catch {
    /* nothing to do — the session still works, it just won't survive a reload */
  }
};

export const hostKeys = readHosts;
export const getHostKey = (pollId) => readHosts()[pollId] || "";
export const setHostKey = (pollId, k) => writeHosts({ ...readHosts(), [pollId]: k });
export const clearHostKey = (pollId) => {
  const map = readHosts();
  delete map[pollId];
  writeHosts(map);
};

/** Forget keys for games that have been played and swept off the board. */
export const pruneHostKeys = (liveIds) => {
  const map = readHosts();
  const live = new Set(liveIds);
  let changed = false;
  for (const id of Object.keys(map)) {
    if (!live.has(id)) { delete map[id]; changed = true; }
  }
  if (changed) writeHosts(map);
};

async function req(path, { method = "GET", body, pollId } = {}) {
  const admin = getKey();
  const host = pollId ? getHostKey(pollId) : "";
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(admin ? { "x-siab-key": admin } : {}),
      ...(host ? { "x-siab-poll-key": host } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * The server stores date and time as bare strings with no offset, so it
 * can't know when the game is really over — a Worker's local time is UTC.
 * The browser can, so the end timestamp is worked out here and sent along.
 */
export function endsAtFrom({ date, time, durationMin }) {
  if (!date) return null;
  const start = new Date(`${date}T${time || "00:00"}`);
  if (isNaN(start)) return null;
  return start.getTime() + (Number(durationMin) || 120) * 60000;
}

export const api = {
  state: () => req("/state"),
  verify: (passcode) => req("/admin/verify", { method: "POST", body: { passcode } }),
  unlock: (id, passcode) => req(`/polls/${id}/unlock`, { method: "POST", body: { passcode } }),

  createPoll: (poll) =>
    req("/polls", { method: "POST", body: { ...poll, endsAt: endsAtFrom(poll) } }),
  updatePoll: (id, patch) =>
    req(`/polls/${id}`, {
      method: "PATCH",
      pollId: id,
      // Any schedule edit has to carry a fresh end timestamp with it,
      // otherwise the server falls back to reading the date as UTC.
      body: "date" in patch || "time" in patch || "durationMin" in patch
        ? { ...patch, endsAt: endsAtFrom(patch) }
        : patch,
    }),
  setClosed: (id, closed) => req(`/polls/${id}`, { method: "PATCH", pollId: id, body: { closed } }),
  deletePoll: (id) => req(`/polls/${id}`, { method: "DELETE", pollId: id }),

  join: (id, name, skill) => req(`/polls/${id}/rsvps`, { method: "POST", body: { name, skill } }),
  leave: (id, name) => req(`/polls/${id}/rsvps`, { method: "DELETE", body: { name } }),
  remove: (id, rsvpId) => req(`/polls/${id}/rsvps/${rsvpId}`, { method: "DELETE", pollId: id }),

  mixRound: (id, teamCount, perTeam) =>
    req(`/polls/${id}/rounds`, { method: "POST", pollId: id, body: { teamCount, perTeam } }),
  undoRound: (id, roundId) =>
    req(`/polls/${id}/rounds/${roundId}`, { method: "DELETE", pollId: id }),

  // pollId is passed so the host key rides along when this browser has one.
  // Anyone may settle an undecided matchup without it; the server is what
  // decides whether you're allowed to overwrite one that's already down.
  setWinner: (id, matchId, winner) =>
    req(`/polls/${id}/matches/${matchId}`, { method: "PUT", pollId: id, body: { winner } }),
  clearRounds: (id) => req(`/polls/${id}/rounds`, { method: "DELETE", pollId: id }),
};
