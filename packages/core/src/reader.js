const NON_TERMINAL = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st",
  "gen", "col", "capt", "lt", "sgt", "rev", "hon", "gov", "pres", "sen", "rep",
  "mt", "ave", "blvd", "rd",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec",
  "approx", "est", "dept", "univ", "inc", "ltd", "co", "corp",
]);
const BEFORE_NUMBER = new Set(["no", "fig", "vol", "pp", "p"]);
const LOWERCASE_CONTINUATIONS = new Set(["etc", "eg", "ie", "vs", "cf", "al", "am", "pm"]);
const SENTENCE_STARTERS = new Set([
  "a", "an", "the", "he", "she", "it", "they", "we", "i", "you",
  "then", "but", "and", "or", "so", "when", "after", "before", "this", "that",
  "these", "those", "there", "here", "his", "her", "their", "its", "our", "my",
  "in", "on", "at", "for", "to", "of", "from", "with", "by", "as", "if",
  "not", "no", "yes", "however", "meanwhile", "still", "also", "now",
]);

function wordBefore(text, index) {
  let start = index - 1;
  while (start >= 0 && /[A-Za-z]/.test(text[start])) start -= 1;
  return text.slice(start + 1, index);
}

function tokenAfter(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  if (cursor >= text.length) return null;
  let end = cursor;
  while (end < text.length && /[A-Za-z]/.test(text[end])) end += 1;
  return {
    word: text.slice(cursor, end),
    dotted: text[end] === ".",
    char: text[cursor],
  };
}

function listMarker(text, periodIndex, number) {
  const before = text.slice(0, periodIndex - number.length);
  if (before.trim() === "") return true;
  const match = before.match(/[.!?。！？][”’"']?\s*$/);
  if (!match) return false;
  const boundary = before.length - match[0].length;
  return text[boundary] !== "." || !continuesAfterPeriod(text, boundary);
}

function continuesAfterPeriod(text, periodIndex) {
  const nextMark = text[periodIndex + 1];
  if (nextMark === "." || nextMark === "!" || nextMark === "?" || nextMark === "。" || nextMark === "！" || nextMark === "？") {
    return false;
  }
  let after = periodIndex + 1;
  while (after < text.length && "”’\"'".includes(text[after])) after += 1;
  const next = tokenAfter(text, after);
  if (!next) return false;
  const prev = wordBefore(text, periodIndex);
  const lowerPrev = prev.toLowerCase();
  const number = text.slice(0, periodIndex).match(/(\d+)$/)?.[1] ?? "";
  if (number && /\d/.test(next.char)) return true;
  if (number.length > 0 && number.length <= 2 && /[A-Za-z]/.test(next.char) && listMarker(text, periodIndex, number)) {
    return true;
  }
  if (BEFORE_NUMBER.has(lowerPrev) && /\d/.test(next.char)) return true;
  if (next.dotted && next.word.length === 1 && prev.length === 1 && /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next.word)) {
    return true;
  }
  if (next.dotted && next.word.length === 1 && /^(?:Ph|M|U|St|Mt)$/.test(prev)) return true;
  if (/[a-z0-9]/.test(next.char)) {
    return NON_TERMINAL.has(lowerPrev) || prev.length === 1 || LOWERCASE_CONTINUATIONS.has(lowerPrev);
  }
  if (!/[A-Z]/.test(next.char)) return false;
  if (NON_TERMINAL.has(lowerPrev)) return true;
  return prev.length === 1 && /[A-Z]/.test(prev) && !SENTENCE_STARTERS.has(next.word.toLowerCase());
}

export function splitSentences(paragraph) {
  if (typeof paragraph !== "string" || paragraph === "") return [paragraph];
  const sentences = [];
  let start = 0;
  for (let index = 0; index < paragraph.length; index += 1) {
    const char = paragraph[index];
    if (!".!?。！？".includes(char)) continue;
    if (char === "." && continuesAfterPeriod(paragraph, index)) continue;
    let end = index + 1;
    while (end < paragraph.length && ".!?。！？".includes(paragraph[end])) end += 1;
    while (end < paragraph.length && "”’\"'".includes(paragraph[end])) end += 1;
    const sentence = paragraph.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    index = end - 1;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

export function tokenizeSentence(sentence) {
  return sentence.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\s+|[^A-Za-z\s]+/g) ??
    [sentence];
}

export function annotateTokens(tokens, sentenceKey) {
  return tokens.map((token, tokenIndex) => ({
    token,
    tokenIndex,
    key: `${sentenceKey}-${tokenIndex}`,
    word: normalizeWord(token),
  }));
}

export function selectionSpan(items, selectedKeys = []) {
  const keys = new Set(selectedKeys);
  const hits = items
    .map((item, index) => (item.word && keys.has(item.key) ? index : -1))
    .filter((index) => index >= 0);
  if (!hits.length) return null;
  return { start: Math.min(...hits), end: Math.max(...hits) };
}

export function phraseFromItems(items, span) {
  if (!span) return "";
  return items
    .slice(span.start, span.end + 1)
    .map((item) => item.token)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSentenceEnding(sentence) {
  const match = sentence.match(/([.!?。！？]+[”’"]?)$/);
  if (!match) return { body: sentence, ending: "·" };
  return {
    body: sentence.slice(0, -match[0].length),
    ending: match[0],
  };
}

export function normalizeWord(token) {
  return token.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
}

export function estimateReadingMinutes(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 180));
}

export function remainingReadingMinutes(text, progress = 0, fallbackMinutes = 5) {
  const leftover = 1 - Math.min(0.99, Math.max(0, progress || 0));
  const estimated = estimateReadingMinutes(text || "a");
  const listed = Math.max(1, Number(fallbackMinutes) || 5);
  const total = Math.max(estimated, listed);
  return Math.max(1, Math.round(total * leftover));
}

export function flattenSentences(paragraphs = []) {
  return (paragraphs ?? []).flatMap((paragraph, paragraphIndex) =>
    splitSentences(paragraph).map((sentence, sentenceIndex) => ({
      paragraphIndex,
      sentenceIndex,
      key: `${paragraphIndex}-${sentenceIndex}`,
      text: sentence,
    })),
  );
}

export function speechChunks(text, maxLength = 120) {
  const sentence = String(text ?? "");
  const limit = Math.max(40, Number(maxLength) || 120);
  if (!sentence) return [];
  if (sentence.length <= limit) return [{ text: sentence, start: 0 }];
  const chunks = [];
  let cursor = 0;
  while (cursor < sentence.length) {
    if (sentence.length - cursor <= limit) {
      chunks.push({ text: sentence.slice(cursor), start: cursor });
      break;
    }
    const space = sentence.slice(cursor, cursor + limit).lastIndexOf(" ");
    const end = space > 40 ? cursor + space : cursor + limit;
    const spoken = sentence.slice(cursor, end).replace(/\s+$/, "");
    if (spoken) chunks.push({ text: spoken, start: cursor });
    cursor = end;
    while (cursor < sentence.length && sentence[cursor] === " ") cursor += 1;
  }
  return chunks;
}

export function shouldFlushProgressOnAppState(state) {
  return state === "inactive" || state === "background";
}

export function spokenProgress(index, total) {
  if (!total) return 0;
  const safe = Number.isFinite(index) ? index : -1;
  if (safe < 0) return 0;
  return Math.min(1, (safe + 1) / total);
}

export function wordKeyAtChar(sentenceKey, sentence, charIndex) {
  if (!sentence || !Number.isFinite(charIndex) || charIndex < 0) return "";
  const { body } = splitSentenceEnding(sentence);
  const items = annotateTokens(tokenizeSentence(body), sentenceKey);
  let cursor = 0;
  let lastWordKey = "";
  for (const item of items) {
    const start = cursor;
    cursor += item.token.length;
    if (!item.word) continue;
    lastWordKey = item.key;
    if (charIndex >= start && charIndex < cursor) return item.key;
  }
  return charIndex >= cursor ? lastWordKey : "";
}

export async function sha256(input) {
  const bytes = input instanceof ArrayBuffer
    ? input
    : new TextEncoder().encode(typeof input === "string" ? input : JSON.stringify(input));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function contentHashFromParagraphs(paragraphs) {
  return sha256(paragraphs.map((value) => value.trim()).join("\n\n"));
}

export function contextWindow(paragraphs, paragraphIndex, sentenceIndex) {
  const sentences = paragraphs.map(splitSentences);
  const current = sentences[paragraphIndex]?.[sentenceIndex] ?? "";
  const before = sentenceIndex > 0
    ? sentences[paragraphIndex][sentenceIndex - 1]
    : sentences[paragraphIndex - 1]?.at(-1) ?? "";
  const after = sentenceIndex < (sentences[paragraphIndex]?.length ?? 0) - 1
    ? sentences[paragraphIndex][sentenceIndex + 1]
    : sentences[paragraphIndex + 1]?.[0] ?? "";
  return { current, before, after };
}
