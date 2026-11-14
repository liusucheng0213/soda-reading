// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { vocabularyItemId } from "@soda-reading/core";
import { ReaderScreen } from "../screens/ReaderScreen.jsx";
import { upsertVocabularyItem } from "./vocabulary.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date("2026-11-13T08:00:00+08:00");
const candidate = {
  id: vocabularyItemId("piece", "shade", "Trees give shade."),
  contentId: "piece",
  contentHash: "piece-hash",
  chapterId: "main",
  word: "shade",
  sentence: "Trees give shade.",
  translation: "树荫",
  learningState: "learning",
  masteredAt: null,
};

describe("vocabulary marking", () => {
  it("adds a new contextual word with an explicit learning state and FSRS card", () => {
    const result = upsertVocabularyItem([], candidate, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: candidate.id,
      learningState: "learning",
      masteredAt: null,
      card: { due: now.toISOString(), reps: 0 },
    });
  });

  it("does not duplicate the same contextual word", () => {
    const items = [{ ...candidate, card: { due: now.toISOString(), reps: 2 } }];
    expect(upsertVocabularyItem(items, candidate, now)).toBe(items);
  });

  it("restores rather than duplicates an explicitly re-marked mastered word", () => {
    const mastered = {
      ...candidate,
      learningState: "mastered",
      masteredAt: "2026-11-01T00:00:00.000Z",
      card: { due: "2027-01-01T00:00:00.000Z", reps: 7 },
    };
    const result = upsertVocabularyItem([mastered], candidate, now);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(candidate.id);
    expect(result[0].learningState).toBe("learning");
    expect(result[0].masteredAt).toBeNull();
    expect(result[0].card).toMatchObject({ due: now.toISOString(), reps: 7 });
  });

  it("keeps separate cards for the same word in different sentences", () => {
    const other = {
      ...candidate,
      id: vocabularyItemId("piece", "shade", "She sat in the shade."),
      sentence: "She sat in the shade.",
      translation: "阴凉处",
    };
    const result = upsertVocabularyItem([{ ...candidate, card: { due: now.toISOString() } }], other, now);
    expect(result).toHaveLength(2);
    expect(result[0].id).not.toBe(result[1].id);
    expect(result.map((item) => item.translation)).toEqual(["树荫", "阴凉处"]);
  });

  it("does not save a word without a contextual meaning", () => {
    const items = [];
    expect(upsertVocabularyItem(items, { ...candidate, translation: "" }, now)).toBe(items);
  });

  it("does not treat a referent label as a translation", () => {
    const items = [];
    const invalid = { ...candidate, translation: "", referent: "前文提到的树木" };
    expect(upsertVocabularyItem(items, invalid, now)).toBe(items);
  });
});


const readerArticle = {
  id: "piece",
  contentHash: "piece-hash",
  title: "Trees",
  paragraphs: ["Trees give shade."],
  glossary: [{ word: "shade", sentence: "Trees give shade.", translation: "树荫" }],
};

function readerProps(vocabulary, onVocabularyChange) {
  return {
    article: readerArticle,
    theme: "day",
    readingPrefs: {},
    onReadingPrefsChange: () => {},
    onThemeChange: () => {},
    onBack: () => {},
    vocabulary,
    onVocabularyChange,
    highlights: [],
    onHighlightsChange: () => {},
    progress: 0,
    position: null,
    onProgress: () => {},
    focus: null,
    onFocusConsumed: () => {},
    feedback: null,
    onFeedback: () => {},
    onReview: () => {},
    onAdjustLevel: () => {},
  };
}

describe("reader vocabulary mode", () => {
  it("keeps ordinary word clicks as gloss-only interactions", async () => {
    let saves = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(ReaderScreen, readerProps([], () => { saves += 1; }))));
    let word = container.querySelector("[data-word-surface='shade']");

    await act(async () => word.click());
    expect(container.textContent).toContain("树荫");
    expect(saves).toBe(0);
    word = container.querySelector("[data-word-surface='shade']");
    await act(async () => word.click());
    expect(container.textContent).not.toContain("树荫");
    await act(async () => root.unmount());
    container.remove();
  });

  it("saves a prepared translation in marking mode without duplicating a repeated word", async () => {
    let saved = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onVocabularyChange = (update) => {
      saved = typeof update === "function" ? update(saved) : update;
    };
    await act(async () => root.render(React.createElement(ReaderScreen, readerProps(saved, onVocabularyChange))));
    const mode = container.querySelector("button[aria-label='生词标记']");
    expect(mode?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => mode.click());
    expect(mode.getAttribute("aria-pressed")).toBe("true");
    let word = container.querySelector("[data-word-surface='shade']");
    await act(async () => word.click());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ word: "shade", translation: "树荫", learningState: "learning" });

    await act(async () => root.render(React.createElement(ReaderScreen, readerProps(saved, onVocabularyChange))));
    word = container.querySelector("[data-word-surface='shade']");
    await act(async () => word.click());
    expect(saved).toHaveLength(1);
    expect(container.textContent).toContain("树荫");
    await act(async () => root.unmount());
    container.remove();
  });
});
