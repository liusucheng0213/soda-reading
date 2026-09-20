const SENTENCE_PATTERN = /[^.!?。！？]+(?:[.!?。！？]+[”’"]?|$)/g;

export function splitSentences(paragraph) {
  return paragraph.match(SENTENCE_PATTERN)?.map((item) => item.trim()).filter(Boolean) ??
    [paragraph];
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
