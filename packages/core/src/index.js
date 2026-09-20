export * from "./reader.js";
export * from "./review.js";
export { assertSafeZip } from "./zip.js";

export const CEFR_LEVELS = ["A2", "B1", "B2", "C1"];
export const INTEREST_TOPICS = ["科技", "文化", "商业", "自然", "健康", "历史"];
export const DEFAULT_REVIEW_LIMIT = 20;

export function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function usernameToInternalEmail(username) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9_]{3,24}$/.test(normalized)) {
    throw new Error("用户名需为 3–24 位小写字母、数字或下划线");
  }
  return `${normalized}@users.soda.invalid`;
}

export function newIdempotencyKey() {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
