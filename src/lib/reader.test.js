import { describe, expect, it } from "vitest";
import {
  annotateTokens,
  estimateReadingMinutes,
  normalizeWord,
  phraseFromItems,
  selectionSpan,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
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
});
