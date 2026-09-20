import { describe, expect, it, vi } from "vitest";
import { copyText, listenHotkeyBlocked, locateWordInArticle, markedRun, uniqueArticles, vocabMatch, vocabSource } from "./study.js";

describe("study helpers", () => {
  it("keeps the first complete article for each id", () => {
    const articles = uniqueArticles([
      { id: "a", paragraphs: ["One."] },
      { id: "a", paragraphs: ["Two."] },
      { id: "b" },
      { id: "c", paragraphs: ["Three."] },
    ]);
    expect(articles.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("prefers a vocabulary match from the same sentence", () => {
    const vocabulary = [
      { word: "bank", sentence: "We sat on the river bank.", translation: "河岸" },
      { word: "bank", sentence: "She works at a bank.", translation: "银行" },
    ];
    expect(vocabMatch(vocabulary, "bank", "She works at a bank.").translation).toBe("银行");
  });

  it("finds the original sentence and word key so 原文 can return to the same place", () => {
    const located = locateWordInArticle(
      ["Cities can feel much hotter than the fields around them.", "That process is called transpiration, and it lowers the temperature around the tree."],
      { word: "transpiration", sentence: "That process is called transpiration, and it lowers the temperature around the tree." },
    );
    expect(located).toMatchObject({
      paragraphIndex: 1,
      sentenceKey: "1-0",
      word: "transpiration",
    });
    expect(located.wordKey).toContain("1-0-");
  });

  it("copies with execCommand first so a click gesture is not lost after clipboard rejects", async () => {
    const exec = vi.fn(() => true);
    const node = { value: "", setAttribute() {}, style: {}, select() {}, remove() {} };
    vi.stubGlobal("document", {
      execCommand: exec,
      createElement: () => node,
      body: { appendChild() {} },
    });
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("Cities can feel much hotter.")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("lets Space and listen shortcuts fire from the listen bar, not from the find field", () => {
    const listenButton = { closest: (selector) => selector.includes(".reader-listen") ? {} : selector.includes("button") ? {} : null };
    const findInput = { closest: (selector) => selector.includes("input") ? {} : null };
    const articleWord = { closest: (selector) => selector.includes("button") ? {} : null };
    const paper = { closest: () => null };
    expect(listenHotkeyBlocked(listenButton)).toBe(false);
    expect(listenHotkeyBlocked(findInput)).toBe(true);
    expect(listenHotkeyBlocked(articleWord)).toBe(true);
    expect(listenHotkeyBlocked(paper)).toBe(false);
  });

  it("groups consecutive highlighted words into one underline run", () => {
    const items = [
      { key: "a", word: "but" },
      { key: "s1", word: "" },
      { key: "b", word: "even" },
      { key: "s2", word: "" },
      { key: "c", word: "shade" },
    ];
    expect(markedRun(items, 0, new Set(["a", "b"]))).toEqual({ start: 0, end: 2 });
    expect(markedRun(items, 4, new Set(["a", "b"]))).toBeNull();
    expect(markedRun(items, 0, new Set(["a"]))).toBeNull();
  });

  it("finds the original article for a saved word from catalog or imports", () => {
    const catalog = [
      { id: "trees", contentHash: "hash-trees", paragraphs: ["Shade."] },
      { id: "local-1", contentHash: "import-1", paragraphs: ["Hello."] },
    ];
    expect(vocabSource(catalog, { contentId: "trees" }).id).toBe("trees");
    expect(vocabSource(catalog, { contentHash: "import-1" }).id).toBe("local-1");
  });
});
