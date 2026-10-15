import { describe, expect, it, vi } from "vitest";
import { dueCards, savedVocabularySense, sentenceKey, vocabularyItemId } from "@soda-reading/core";
import { collectFindHits, copyText, glossText, hasCommonGloss, listenHotkeyBlocked, locateWordInArticle, markedRun, uniqueArticles, vocabMatch, vocabSource, applyReadingProgress, canUseSpeech, keepShownGloss, mergeRemoteProgress, mergeVocabulary, resumeFromProgress, isCurrentSave, pendingReadingOffset, resumeSpeechIfStuck, shouldFlushProgressOnHide, shouldRestoreReadingOffset, todayReadMinutes, vocabularyRemoteSave } from "./study.js";

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
      { contentId: "piece", word: "bank", sentence: "We sat on the river bank.", translation: "河岸" },
      { contentId: "piece", word: "bank", sentence: "She works at a bank.", translation: "银行" },
    ];
    expect(vocabMatch(vocabulary, "bank", "She works at a bank.").translation).toBe("银行");
    expect(vocabMatch(vocabulary, "bank", "Another bank showed up.", { exact: true })).toBeNull();
    expect(savedVocabularySense(vocabulary, "piece", "bank", "She works at a bank.").translation).toBe("银行");
    expect(savedVocabularySense(vocabulary, "piece", "bank", "Another bank showed up.")).toBeNull();
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

  it("lets Space and listen shortcuts fire from the listen bar, not from the find field or a word", () => {
    const listenButton = { closest: (selector) => selector.includes(".reader-listen") ? {} : null };
    const findInput = { closest: (selector) => selector.includes("input") ? {} : null };
    const articleWord = { closest: (selector) => selector.includes("[role='button']") ? {} : null };
    const paper = { closest: () => null };
    expect(listenHotkeyBlocked(listenButton)).toBe(false);
    expect(listenHotkeyBlocked(findInput)).toBe(true);
    expect(listenHotkeyBlocked(articleWord)).toBe(true);
    expect(listenHotkeyBlocked(paper)).toBe(false);
  });

  it("counts only newly covered progress toward today's minutes", () => {
    const article = { id: "piece", paragraphs: ["word ".repeat(360)], readingMinutes: 2 };
    const started = applyReadingProgress(null, article, 0.4, 0.9, "2026-10-15");
    expect(started.minutes).toBeCloseTo(1);
    expect(todayReadMinutes(started, "2026-10-15")).toBe(1);
    const continued = applyReadingProgress(started, article, 0.4, 1, "2026-10-15");
    expect(continued.minutes).toBeCloseTo(1.2);
    expect(todayReadMinutes(continued, "2026-10-15")).toBe(1);
    const nextDay = applyReadingProgress(continued, article, 1, 1, "2026-10-16");
    expect(todayReadMinutes(nextDay, "2026-10-16")).toBe(0);
  });

  it("detects whether this device can speak", () => {
    expect(canUseSpeech({})).toBe(false);
    expect(canUseSpeech({ speechSynthesis: { speak() {} } })).toBe(true);
  });

  it("nudges a stuck speech engine without resuming a paused sentence", () => {
    const resume = vi.fn();
    expect(resumeSpeechIfStuck({ speaking: true, paused: false, resume })).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    expect(resumeSpeechIfStuck({ speaking: true, paused: true, resume })).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("keeps a gloss that is already on the page when the network translation fails", () => {
    const shown = { word: "shade", status: "success", result: { translation: "树荫" }, error: "" };
    expect(keepShownGloss(shown, { word: "shade", status: "error", result: null, error: "失败" }).result.translation).toBe("树荫");
    expect(keepShownGloss({ word: "shade", status: "loading", result: null }, { status: "error", result: null }).status).toBe("error");
  });

  it("restores the further cloud progress and can resume that article", () => {
    const merged = mergeRemoteProgress({ trees: 0.2 }, [
      { content_id: "trees", progress: 0.1 },
      { content_id: "books", progress: 0.4 },
    ]);
    expect(merged).toEqual({ trees: 0.2, books: 0.4 });
    const catalog = [
      { id: "trees", paragraphs: ["Shade."] },
      { id: "books", paragraphs: ["Books."] },
    ];
    expect(resumeFromProgress(catalog, merged, null).id).toBe("books");
    expect(resumeFromProgress(catalog, merged, { id: "trees", progress: 0.2 }).id).toBe("trees");
  });

  it("keeps two contextual senses of the same word", () => {
    const river = {
      id: "piece:bank",
      contentId: "piece",
      word: "bank",
      sentence: "We sat on the river bank.",
      translation: "河岸",
      card: { due: 1 },
    };
    const finance = {
      id: "remote",
      contentId: "piece",
      word: "bank",
      sentence: "She works at a bank.",
      translation: "银行",
      remoteId: "uuid",
    };
    const merged = mergeVocabulary([river], [finance]);
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.translation === "河岸").card.due).toBe(1);
    expect(vocabularyItemId("piece", "Bank", river.sentence)).not.toBe(vocabularyItemId("piece", "bank", finance.sentence));
    expect(sentenceKey("We sat on the river bank.")).toBe("1684fa3b");
    expect(sentenceKey("")).toBe("00001505");
    expect(sentenceKey("We sat on the river bank.")).toBe(sentenceKey("we   sat on the river bank."));
  });

  it("does not restore a word that was deleted before the cloud save finished", () => {
    const kept = [{ id: "keep", word: "shade" }];
    expect(vocabularyRemoteSave(kept, "gone", "remote-1")).toEqual({
      items: kept,
      deletedRemoteId: "remote-1",
    });
    expect(vocabularyRemoteSave([{ id: "keep", word: "shade" }], "keep", "remote-2").items[0].remoteId).toBe("remote-2");
  });

  it("keeps a local common sense when the cloud row has not stored one", () => {
    const local = [{
      contentId: "piece",
      word: "bank",
      sentence: "We sat on the river bank.",
      translation: "河岸",
      commonTranslation: "银行",
      referent: true,
    }];
    const remote = [{
      contentId: "piece",
      word: "bank",
      sentence: "We sat on the river bank.",
      translation: "河岸",
      commonTranslation: "",
      remoteId: "uuid",
    }];
    const merged = mergeVocabulary(local, remote)[0];
    expect(merged.commonTranslation).toBe("银行");
    expect(merged.referent).toBe(true);
    expect(merged.remoteId).toBe("uuid");
  });

  it("keeps local-only vocabulary when the cloud list is empty or partial", () => {
    const local = [{ id: "a:shade", word: "shade", translation: "树荫" }];
    const remote = [{ id: "b:tree", word: "tree", translation: "树", remoteId: "1" }];
    expect(mergeVocabulary(local, []).map((item) => item.word)).toEqual(["shade"]);
    expect(mergeVocabulary(local, remote).map((item) => item.word)).toEqual(["shade", "tree"]);
    expect(mergeVocabulary([{ id: "b:tree", word: "tree", translation: "旧" }], remote)[0].translation).toBe("树");
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

  it("finds a phrase across neighboring words and still finds a single word", () => {
    const paragraphs = ["This is called the urban heat island."];
    const phrase = collectFindHits(paragraphs, "heat island");
    expect(phrase).toHaveLength(1);
    expect(phrase[0]).toHaveLength(2);
    const single = collectFindHits(paragraphs, "urban");
    expect(single).toHaveLength(1);
    expect(single[0]).toHaveLength(1);
    expect(single[0][0]).not.toBe(phrase[0][0]);
    expect(collectFindHits(paragraphs, "island heat")).toEqual([]);
  });

  it("labels a pronoun with 文中指代 and keeps a differing common sense on its own line", () => {
    expect(glossText({ referent: true, translation: "指代脉冲星" })).toBe("文中指代 脉冲星");
    expect(glossText({ referent: true, translation: "文中指代 前文的恒星风" })).toBe("文中指代 前文的恒星风");
    expect(glossText({ translation: "河岸", commonTranslation: "银行" })).toBe("河岸");
    expect(hasCommonGloss({ translation: "河岸", commonTranslation: "银行" })).toBe(true);
    expect(hasCommonGloss({ referent: true, translation: "指代脉冲星", commonTranslation: "它" })).toBe(false);
    expect(glossText({ translation: "文中指代河岸" })).toBe("文中指代 河岸");
    expect(hasCommonGloss({ translation: "文中指代河岸", commonTranslation: "它" })).toBe(false);
    expect(isCurrentSave(2, 2)).toBe(true);
    expect(isCurrentSave(1, 2)).toBe(false);
    expect(shouldFlushProgressOnHide({ type: "pagehide" })).toBe(true);
    expect(shouldFlushProgressOnHide({ type: "visibilitychange", visibilityState: "hidden" })).toBe(true);
    expect(shouldFlushProgressOnHide({ type: "visibilitychange", visibilityState: "visible" })).toBe(false);
  });

  it("waits to restore a saved offset until the article is tall enough to scroll", () => {
    expect(pendingReadingOffset(800, 200, 0.5)).toBe(300);
    expect(pendingReadingOffset(200, 200, 0.5)).toBeNull();
    expect(pendingReadingOffset(800, 200, 0)).toBe(0);
  });

  it("restores a late cloud offset unless the reader already moved or wrote it", () => {
    expect(shouldRestoreReadingOffset({ articleChanged: true })).toBe(true);
    expect(shouldRestoreReadingOffset({})).toBe(true);
    expect(shouldRestoreReadingOffset({ ownWrite: true })).toBe(false);
    expect(shouldRestoreReadingOffset({ userMoved: true })).toBe(false);
    expect(shouldRestoreReadingOffset({ hasFocus: true, articleChanged: true })).toBe(false);
  });

  it("keeps a card with a broken due date in the review queue", () => {
    const now = new Date("2026-10-15T00:00:00.000Z");
    const due = dueCards([
      { id: "broken", card: { due: "not-a-date" } },
      { id: "later", card: { due: "2099-01-01T00:00:00.000Z" } },
      { id: "ready", card: { due: "2026-10-14T00:00:00.000Z" } },
    ], 20, now);
    expect(due.map((item) => item.id)).toEqual(["broken", "ready"]);
  });
});
