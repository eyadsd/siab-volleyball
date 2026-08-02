const KEY = "siab.organizer";

export const getKey = () => sessionStorage.getItem(KEY) || "";
export const setKey = (k) => sessionStorage.setItem(KEY, k);
export const clearKey = () => sessionStorage.removeItem(KEY);

async function req(path, { method = "GET", body } = {}) {
  const key = getKey();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-siab-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  state: () => req("/state"),
  verify: (passcode) => req("/admin/verify", { method: "POST", body: { passcode } }),

  createPoll: (poll) => req("/polls", { method: "POST", body: poll }),
  setClosed: (id, closed) => req(`/polls/${id}`, { method: "PATCH", body: { closed } }),
  deletePoll: (id) => req(`/polls/${id}`, { method: "DELETE" }),

  join: (id, name, skill) => req(`/polls/${id}/rsvps`, { method: "POST", body: { name, skill } }),
  leave: (id, name) => req(`/polls/${id}/rsvps`, { method: "DELETE", body: { name } }),
  remove: (id, rsvpId) => req(`/polls/${id}/rsvps/${rsvpId}`, { method: "DELETE" }),

  mixRound: (id, teamCount, perTeam) =>
    req(`/polls/${id}/rounds`, { method: "POST", body: { teamCount, perTeam } }),
  undoRound: (id, roundId) => req(`/polls/${id}/rounds/${roundId}`, { method: "DELETE" }),
  clearRounds: (id) => req(`/polls/${id}/rounds`, { method: "DELETE" }),
};
