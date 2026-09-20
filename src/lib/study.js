import { measureOptions } from "../data.js";
import {
  annotateTokens,
  flattenSentences,
  normalizeWord,
  remainingReadingMinutes,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
} from "./reader.js";

export function hasCommonGloss(result) {
  return Boolean(
    result?.commonTranslation
    && result.commonTranslation !== result.translation
    && !result?.referent,
  );
}

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

export function vocabMatch(vocabulary, word, sentence) {
  const needle = normalizeWord(word) || String(word || "").toLowerCase();
  if (!needle) return null;
  const same = (item) => {
    const saved = normalizeWord(item.word) || "";
    const lemma = normalizeWord(item.lemma || "") || "";
    return (saved === needle || lemma === needle) && item.translation;
  };
  return vocabulary.find((item) => same(item) && item.sentence === sentence)
    || vocabulary.find((item) => same(item))
    || null;
}

export function highlightId(articleId, keys = []) {
  return `${articleId}:${keys.join("-")}`;
}

export function listenHotkeyBlocked(target) {
  if (!target?.closest) return false;
  if (target.closest("input, textarea, select, [contenteditable='true']")) return true;
  const listenChrome = Boolean(target.closest(".reader-listen, .reader-header"));
  return Boolean(target.closest("button, a")) && !listenChrome;
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

export function collectFindHits(paragraphs, needle) {
  const query = needle.trim().toLowerCase();
  if (!query) return [];
  const hits = [];
  (paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
    splitSentences(paragraph).forEach((sentence, sentenceIndex) => {
      const { body } = splitSentenceEnding(sentence);
      annotateTokens(tokenizeSentence(body), `${paragraphIndex}-${sentenceIndex}`).forEach((item) => {
        if (!item.word) return;
        if (item.token.toLowerCase().includes(query) || item.word.includes(query)) hits.push(item.key);
      });
    });
  });
  return hits;
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
