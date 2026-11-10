export const DEFAULT_LOCAL_PROFILE = {
  username: "local",
  level: "B1",
  topics: ["科技", "文化"],
  minutes: 10,
  reminder: "20:30",
  reviewLimit: 20,
  onboarded: false,
};

export function normalizeProfile(value) {
  const profile = value && typeof value === "object" ? value : {};
  const { role: _role, ...withoutRole } = profile;
  return {
    ...DEFAULT_LOCAL_PROFILE,
    ...withoutRole,
    username: "local",
    topics: profile.topics?.length ? profile.topics.slice(0, 4) : [...DEFAULT_LOCAL_PROFILE.topics],
    minutes: [5, 10, 20].includes(profile.minutes) ? profile.minutes : 10,
    reviewLimit: [10, 20, 30, 40, 50].includes(profile.reviewLimit) ? profile.reviewLimit : 20,
    reminder: profile.reminder || "20:30",
    onboarded: Boolean(profile.onboarded),
  };
}
