import { normalizeWord } from "./reader.js";

export * from "./reader.js";
export * from "./gloss.js";
export * from "./library.js";
export * from "./review.js";
export { assertSafeZip } from "./zip.js";

function compactSentence(sentence = "") {
  return String(sentence).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stable across the web client and the Postgres backfill. Low 32 bits, UTF-8. */
export function sentenceKey(sentence = "") {
  const bytes = new TextEncoder().encode(compactSentence(sentence));
  let hash = 5381;
  for (const byte of bytes) {
    hash = Math.imul(hash, 33) ^ byte;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function vocabularyItemId(contentId, word, sentence = "") {
  return `${String(contentId || "").trim()}:${normalizeWord(word)}:${sentenceKey(sentence)}`;
}

export function savedVocabularySense(items, contentId, word, sentence = "") {
  return (items ?? []).find((item) => item?.translation && isSameVocabularyItem(item, contentId, word, sentence)) ?? null;
}

export function isSameVocabularyItem(item, contentId, word, sentence = "") {
  if (!item || !word) return false;
  const content = String(contentId || "").trim();
  if (item.id === vocabularyItemId(content, word, sentence)) return true;
  const itemContent = String(item.contentId || item.contentHash || "").trim();
  return itemContent === content
    && normalizeWord(item.word || "") === normalizeWord(word)
    && compactSentence(item.sentence) === compactSentence(sentence);
}

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
