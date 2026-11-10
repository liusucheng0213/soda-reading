/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderScreen } from "../screens/ReaderScreen.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
afterEach(() => {
  if (root) act(() => root.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function props(article, onProgress = () => {}) {
  return {
    article,
    theme: "day",
    readingPrefs: {},
    onReadingPrefsChange: () => {},
    onThemeChange: () => {},
    onBack: () => {},
    vocabulary: [],
    onVocabularyChange: () => {},
    highlights: [],
    onHighlightsChange: () => {},
    progress: 0,
    onProgress,
    focus: null,
    onFocusConsumed: () => {},
    onFeedback: () => {},
    onReview: () => {},
    onAdjustLevel: () => {},
  };
}

async function mount(article, custom = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ReaderScreen, { ...props(article), ...custom }));
  });
}

describe("mounted chapter reader", () => {
  it("uses a legacy single-chapter ratio for the actual scroll offset", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback) { this.callback = callback; }
      observe(element) {
        Object.defineProperty(element, "scrollHeight", { value: 2000, configurable: true });
        Object.defineProperty(element, "clientHeight", { value: 500, configurable: true });
        this.callback();
      }
      disconnect() {}
    });
    const article = { id: "old", title: "Old", paragraphs: ["A long enough legacy article."] };
    await mount(article, { progress: 0.5 });
    expect(document.querySelector(".reader-scroll").scrollTop).toBe(750);
  });

  it("persists the next chapter before its first spoken sentence starts", async () => {
    const utterances = [];
    const synthesis = { speak: (utterance) => utterances.push(utterance), cancel: vi.fn(), speaking: false, paused: false };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(text) { this.text = text; } });
    const calls = [];
    const article = {
      id: "listen",
      title: "Listen",
      chapters: [
        { id: "chapter-0001", title: "One", paragraphs: ["First chapter."] },
        { id: "chapter-0002", title: "Two", paragraphs: ["Second chapter."] },
      ],
      paragraphs: ["First chapter.", "Second chapter."],
    };
    await mount(article, { onProgress: (...args) => calls.push(args) });
    await act(async () => {
      document.querySelector('button[aria-label="朗读全文"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(utterances).toHaveLength(1);
    await act(async () => { utterances[0].onend(); });
    expect(calls.some(([, location]) => location?.chapterId === "chapter-0002" && location?.chapterProgress === 0)).toBe(true);
  });
});
