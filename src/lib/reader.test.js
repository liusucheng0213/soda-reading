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
  shouldFlushProgressOnAppState,
  speechChunks,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
  wordKeyAtChar,
} from "./reader.js";

describe("reader text processing", () => {
  it("splits a long spoken sentence into chunks that still cover the original words", () => {
    expect(speechChunks("Short sentence.")).toEqual([{ text: "Short sentence.", start: 0 }]);
    const text = `${"alpha ".repeat(30)}omega.`;
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 120)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(text.trim());
    expect(chunks[1].start).toBeGreaterThan(chunks[0].text.length);
  });

  it("saves reading progress when the app leaves the foreground", () => {
    expect(shouldFlushProgressOnAppState("background")).toBe(true);
    expect(shouldFlushProgressOnAppState("inactive")).toBe(true);
    expect(shouldFlushProgressOnAppState("active")).toBe(false);
  });

  it("keeps abbreviations and sentence endings usable for translation markers", () => {
    expect(splitSentences("Dr. Reed arrived. She started reading!")).toEqual([
      "Dr. Reed arrived.",
      "She started reading!",
    ]);
    expect(splitSentences("The U.S. policy changed. It costs 3.14 dollars.")).toEqual([
      "The U.S. policy changed.",
      "It costs 3.14 dollars.",
    ]);
    expect(splitSentences("J. K. Rowling wrote it. She stopped.")).toEqual([
      "J. K. Rowling wrote it.",
      "She stopped.",
    ]);
    expect(splitSentences("She bought pens, etc. Then she left.")).toEqual([
      "She bought pens, etc.",
      "Then she left.",
    ]);
    expect(splitSentences("See Fig. 2. No. 12 is the bus.")).toEqual([
      "See Fig. 2.",
      "No. 12 is the bus.",
    ]);
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
