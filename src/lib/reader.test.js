import { describe, expect, it } from "vitest";
import {
  annotateTokens,
  estimateReadingMinutes,
  flattenSentences,
  normalizeWord,
  phraseFromItems,
  remainingReadingMinutes,
  selectionSpan,
  spokenProgress,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
  wordKeyAtChar,
} from "./reader.js";

describe("reader text processing", () => {
  it("keeps abbreviations and sentence endings usable for translation markers", () => {
    const sentences = splitSentences("Dr. Reed arrived. She started reading!");
    expect(sentences.at(-1)).toBe("She started reading!");
  });

  it("tokenizes apostrophes and hyphenated words", () => {
    const tokens = tokenizeSentence("Readers don't fear fast-changing ideas.");
    expect(tokens).toContain("don't");
    expect(tokens).toContain("fast-changing");
  });

  it("keeps the visible sentence punctuation inside its translation trigger", () => {
    expect(splitSentenceEnding('A complete thought."')).toEqual({
      body: "A complete thought",
      ending: '."',
    });
  });

  it("groups a selected phrase span across tokens", () => {
    const items = annotateTokens(tokenizeSentence("stellar wind plasma"), "0-0");
    const words = items.filter((item) => item.word);
    const span = selectionSpan(items, [words[0].key, words[1].key]);
    expect(phraseFromItems(items, span)).toBe("stellar wind");
  });

  it("normalizes words and estimates a positive reading time", () => {
    expect(normalizeWord("Seeking,")).toBe("seeking");
    expect(estimateReadingMinutes("word ".repeat(181))).toBe(2);
  });

  it("uses leftover words so remaining time shrinks as the reader progresses", () => {
    const text = Array.from({ length: 360 }, (_, index) => `word${index}`).join(" ");
    expect(remainingReadingMinutes(text, 0, 2)).toBeGreaterThanOrEqual(2);
    expect(remainingReadingMinutes(text, 0.5, 2)).toBeLessThan(remainingReadingMinutes(text, 0, 2));
  });

  it("flattens paragraphs into spoken sentences and maps leftover listen progress", () => {
    const items = flattenSentences(["One. Two!", "Three."]);
    expect(items.map((item) => item.text)).toEqual(["One.", "Two!", "Three."]);
    expect(items[1]).toMatchObject({ paragraphIndex: 0, sentenceIndex: 1, key: "0-1" });
    expect(spokenProgress(0, 3)).toBeCloseTo(1 / 3);
    expect(spokenProgress(2, 3)).toBe(1);
  });

  it("maps a speech char index back to the same word key used in the reader", () => {
    const sentence = "That process is called transpiration.";
    const { body } = splitSentenceEnding(sentence);
    const items = annotateTokens(tokenizeSentence(body), "1-3");
    const target = items.find((item) => item.word === "transpiration");
    const index = body.indexOf("transpiration");
    expect(wordKeyAtChar("1-3", sentence, index)).toBe(target.key);
    expect(wordKeyAtChar("1-3", sentence, index + 4)).toBe(target.key);
  });
});
