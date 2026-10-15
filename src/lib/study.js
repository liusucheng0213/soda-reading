import { vocabularyItemId } from "@soda-reading/core";
import { measureOptions } from "../data.js";
import {
  annotateTokens,
  flattenSentences,
  normalizeWord,
  estimateReadingMinutes,
  remainingReadingMinutes,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
} from "./reader.js";

export { glossText, hasCommonGloss, isReferentGloss } from "@soda-reading/core";

export function measureWidth(measure) {
  return measureOptions.find((item) => item.id === measure)?.width ?? "38em";
}

export function remainingMinutes(article, progress = 0) {
  return remainingReadingMinutes(
    (article?.paragraphs ?? []).join(" "),
    progress,
    article?.readingMinutes,
  );
}

function compactSentence(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function vocabMatch(vocabulary, word, sentence, { exact = false } = {}) {
  const needle = normalizeWord(word) || String(word || "").toLowerCase();
  if (!needle) return null;
  const same = (item) => {
    const saved = normalizeWord(item.word) || "";
    const lemma = normalizeWord(item.lemma || "") || "";
    return (saved === needle || lemma === needle) && item.translation;
  };
  const spoken = compactSentence(sentence);
  const sameSentence = (vocabulary ?? []).find((item) => same(item) && compactSentence(item.sentence) === spoken);
  if (sameSentence || exact) return sameSentence ?? null;
  return (vocabulary ?? []).find((item) => same(item)) ?? null;
}

export function highlightId(articleId, keys = []) {
  return `${articleId}:${keys.join("-")}`;
}

const ANNOTATION_TARGET = "[data-word-key], .sentence-dot, .sentence-translation, .word-gloss, .gloss-actions, .annotated, .word-cluster.selected, a";

export function clickKeepsAnnotation(target) {
  return Boolean(target?.closest?.(ANNOTATION_TARGET));
}

export function listenHotkeyBlocked(target) {
  if (!target?.closest) return false;
  if (target.closest("input, textarea, select, [contenteditable='true']")) return true;
  if (target.closest(".reader-listen, .reader-header")) return false;
  return Boolean(target.closest("button, a, [role='button']"));
}

export function canUseSpeech(target = globalThis) {
  return Boolean(target?.speechSynthesis && typeof target.speechSynthesis.speak === "function");
}

export function resumeSpeechIfStuck(synthesis) {
  if (!synthesis?.speaking || synthesis.paused || typeof synthesis.resume !== "function") return false;
  synthesis.resume();
  return true;
}

export function isCurrentSave(generation, latest) {
  return generation === latest;
}

export function shouldFlushProgressOnHide(event) {
  if (event?.type === "pagehide") return true;
  const state = event?.visibilityState ?? event?.target?.visibilityState;
  return state === "hidden";
}

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function articleTotalMinutes(article) {
  const text = (article?.paragraphs ?? []).join(" ").trim();
  const estimated = estimateReadingMinutes(text || "a");
  const listed = Math.max(1, Number(article?.readingMinutes) || 1);
  return Math.max(estimated, listed);
}

function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

export function applyReadingProgress(log, article, previous, next, today = shanghaiDate()) {
  const fresh = !log || log.date !== today;
  const cursor = { ...(fresh ? {} : log?.cursor || {}) };
  let minutes = fresh ? 0 : Number(log?.minutes) || 0;
  const id = article?.id;
  if (!id) return { date: today, minutes, cursor };
  const start = cursor[id] ?? clampProgress(previous);
  const safeNext = clampProgress(next);
  const delta = Math.max(0, safeNext - start);
  cursor[id] = Math.max(start, safeNext);
  minutes += delta * articleTotalMinutes(article);
  return { date: today, minutes, cursor };
}

export function pendingReadingOffset(scrollHeight, clientHeight, progress) {
  const max = Math.max(0, Number(scrollHeight) - Number(clientHeight));
  const ratio = Math.min(1, Math.max(0, Number(progress) || 0));
  if (ratio <= 0.02) return 0;
  if (max < 24) return null;
  return max * ratio;
}

export function shouldRestoreReadingOffset({ articleChanged = false, ownWrite = false, userMoved = false, hasFocus = false } = {}) {
  if (hasFocus) return false;
  if (articleChanged) return true;
  if (ownWrite || userMoved) return false;
  return true;
}

export function todayReadMinutes(log, today = shanghaiDate()) {
  if (!log || log.date !== today) return 0;
  return Math.max(0, Math.round(Number(log.minutes) || 0));
}

export function keepShownGloss(current, fallback) {
  if (current?.result?.translation) return { ...current, status: "success", error: "" };
  return fallback;
}

export function mergeRemoteProgress(local = {}, rows = []) {
  const next = { ...local };
  for (const row of rows ?? []) {
    const id = row?.content_id || row?.contentId || row?.content_hash || row?.contentHash;
    if (!id) continue;
    const remote = Number(row.progress ?? 0);
    if (!Number.isFinite(remote)) continue;
    const current = Number(next[id] ?? 0);
    if (remote > current) next[id] = Math.min(1, Math.max(0, remote));
  }
  return next;
}

function vocabularyMergeKey(item) {
  const content = item?.contentId || item?.contentHash || "";
  if (content && item?.word && item?.sentence) return vocabularyItemId(content, item.word, item.sentence);
  return item?.id || "";
}

export function vocabularyRemoteSave(items = [], itemId, remoteId) {
  const list = items ?? [];
  if (!itemId || !remoteId || !list.some((entry) => entry.id === itemId)) {
    return { items: list, deletedRemoteId: remoteId || "" };
  }
  return {
    items: list.map((entry) => entry.id === itemId ? { ...entry, remoteId } : entry),
    deletedRemoteId: "",
  };
}

export function mergeVocabulary(local = [], remote = []) {
  const byId = new Map();
  for (const item of [...(local ?? []), ...(remote ?? [])]) {
    const key = vocabularyMergeKey(item);
    if (!key) continue;
    const previous = byId.get(key);
    const content = item.contentId || item.contentHash || "";
    const id = content && item.word && item.sentence
      ? vocabularyItemId(content, item.word, item.sentence)
      : item.id;
    const merged = previous
      ? { ...previous, ...item, id: id || previous.id }
      : { ...item, id: id || item.id };
    if (previous) {
      for (const field of ["translation", "commonTranslation", "lemma", "phonetic", "partOfSpeech"]) {
        if ((item?.[field] === "" || item?.[field] == null) && previous[field]) merged[field] = previous[field];
      }
      if (item?.referent == null && previous.referent) merged.referent = previous.referent;
    }
    if (previous?.card && !item.card) merged.card = previous.card;
    if (previous?.remoteId && !item.remoteId) merged.remoteId = previous.remoteId;
    byId.set(key, merged);
  }
  return [...byId.values()];
}

export function resumeFromProgress(catalog = [], progress = {}, resume = null) {
  const currentValue = Number(progress[resume?.id] ?? resume?.progress ?? 0);
  if (resume?.id && currentValue > 0.02 && currentValue < 0.96) return resume;
  const candidate = [...catalog]
    .map((article) => ({ article, value: Number(progress[article?.id] ?? 0) }))
    .filter((item) => item.article?.paragraphs?.length && item.value > 0.02 && item.value < 0.96)
    .sort((left, right) => right.value - left.value)[0];
  if (!candidate) return resume ?? null;
  return { ...candidate.article, progress: candidate.value };
}

export function markedRun(items, start, markedKeys) {
  const keys = markedKeys instanceof Set ? markedKeys : new Set(markedKeys ?? []);
  if (!items[start]?.word || !keys.has(items[start].key)) return null;
  let lastWord = start;
  for (let index = start + 1; index < items.length; index += 1) {
    if (!items[index].word) continue;
    if (!keys.has(items[index].key)) break;
    lastWord = index;
  }
  if (lastWord === start) return null;
  return { start, end: lastWord };
}

export function freshnessLabel(article) {
  const raw = article.sourcePublishedAt ?? article.publishedAt;
  const published = raw ? new Date(raw) : null;
  if (!published || Number.isNaN(published.getTime())) return "";
  const age = Math.max(0, Math.floor((Date.now() - published.getTime()) / 86_400_000));
  if (age === 0) return "今天";
  if (age === 1) return "昨天";
  if (age < 30) return `${age} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).format(published);
}

function keysCovering(words, pieces, start, end) {
  const keys = [];
  let cursor = 0;
  pieces.forEach((piece, index) => {
    const pieceEnd = cursor + piece.length;
    if (pieceEnd > start && cursor < end) keys.push(words[index].key);
    cursor = pieceEnd + 1;
  });
  return keys;
}

export function collectFindHits(paragraphs, needle) {
  const query = String(needle ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!query) return [];
  const matches = [];
  (paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
    splitSentences(paragraph).forEach((sentence, sentenceIndex) => {
      const { body } = splitSentenceEnding(sentence);
      const words = annotateTokens(tokenizeSentence(body), `${paragraphIndex}-${sentenceIndex}`)
        .filter((item) => item.word);
      if (!query.includes(" ")) {
        words.forEach((item) => {
          if (item.token.toLowerCase().includes(query) || item.word.includes(query)) matches.push([item.key]);
        });
        return;
      }
      const pieces = words.map((item) => item.token.toLowerCase());
      const joined = pieces.join(" ");
      let from = 0;
      while (from < joined.length) {
        const at = joined.indexOf(query, from);
        if (at < 0) break;
        const keys = keysCovering(words, pieces, at, at + query.length);
        if (keys.length) matches.push(keys);
        from = at + Math.max(query.length, 1);
      }
    });
  });
  return matches;
}

export async function copyText(value) {
  const text = String(value ?? "");
  if (!text) return false;
  if (copyWithExecCommand(text)) return true;
  try {
    if (!globalThis.navigator?.clipboard?.writeText) return false;
    await Promise.race([
      globalThis.navigator.clipboard.writeText(text),
      new Promise((_, reject) => {
        globalThis.setTimeout(() => reject(new Error("clipboard-timeout")), 400);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

function copyWithExecCommand(text) {
  if (typeof document === "undefined") return false;
  const node = document.createElement("textarea");
  node.value = text;
  node.setAttribute("readonly", "");
  node.style.position = "fixed";
  node.style.left = "-9999px";
  document.body.appendChild(node);
  node.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  node.remove();
  return ok;
}

export function uniqueArticles(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || !item.paragraphs?.length || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function vocabSource(catalog = [], item) {
  if (!item) return null;
  return catalog.find((article) =>
    article.id === item.contentId
    || article.id === item.contentHash
    || article.contentHash === item.contentId
    || article.contentHash === item.contentHash
  ) || null;
}

export function locateWordInArticle(paragraphs, { word, sentence } = {}) {
  const needle = normalizeWord(word);
  if (!needle) return null;
  const spoken = flattenSentences(paragraphs);
  const normalizedSentence = String(sentence || "").replace(/\s+/g, " ").trim();
  const match = spoken.find((item) => item.text === normalizedSentence)
    || spoken.find((item) => normalizedSentence && item.text.includes(normalizedSentence.slice(0, 28)))
    || spoken.find((item) => {
      const { body } = splitSentenceEnding(item.text);
      return annotateTokens(tokenizeSentence(body), item.key).some((token) => token.word === needle);
    });
  if (!match) return null;
  const { body } = splitSentenceEnding(match.text);
  const token = annotateTokens(tokenizeSentence(body), match.key).find((item) => item.word === needle);
  return {
    paragraphIndex: match.paragraphIndex,
    sentenceIndex: match.sentenceIndex,
    sentenceKey: match.key,
    wordKey: token?.key || "",
    sentence: match.text,
    word: token?.token || word,
  };
}

export function wordContextAt(paragraphs, located) {
  if (!located) return null;
  const sentences = splitSentences(paragraphs[located.paragraphIndex] || "");
  const previous = located.paragraphIndex > 0 ? splitSentences(paragraphs[located.paragraphIndex - 1] || "") : [];
  const next = located.paragraphIndex < (paragraphs?.length ?? 0) - 1
    ? splitSentences(paragraphs[located.paragraphIndex + 1] || "")
    : [];
  const sentence = sentences[located.sentenceIndex] || located.sentence;
  return {
    word: located.word,
    sentence,
    before: sentences[located.sentenceIndex - 1] ?? previous.at(-1) ?? "",
    after: sentences[located.sentenceIndex + 1] ?? next[0] ?? "",
    key: located.wordKey,
    keys: located.wordKey ? [located.wordKey] : [],
    sentenceKey: located.sentenceKey,
  };
}
