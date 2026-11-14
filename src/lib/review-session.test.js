// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { currentReviewItem, masterSessionCard, rateSessionCard, startReviewSession, undoReviewSession } from "@soda-reading/core";
import { ReviewSession } from "../screens/ReviewSession.jsx";
import { VocabularyScreen } from "../screens/VocabularyScreen.jsx";
import { ReadingCompletion } from "../screens/ReadingCompletion.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date("2026-11-10T08:00:00+08:00");
const words = [
  { id: "a", word: "shade", sentence: "Trees give shade.", translation: "树荫", learningState: "learning", masteredAt: null },
  { id: "b", word: "curiosity", sentence: "Curiosity helps us learn.", translation: "好奇心", learningState: "learning", masteredAt: null },
];

describe("review session state", () => {
  it("starts saved learning words as new due cards", () => {
    const session = startReviewSession(words, 20, now);
    expect(session.total).toBe(2);
    expect(session.completed).toBe(0);
    expect(currentReviewItem(session).id).toBe("a");
    expect(currentReviewItem(session).card.due).toBe(now.toISOString());
  });

  it("requeues Again with its new FSRS state and without counting it complete", () => {
    const session = startReviewSession(words, 20, now);
    const result = rateSessionCard(session, Rating.Again, now);
    expect(result.session.completed).toBe(0);
    expect(result.session.queue.map((item) => item.id)).toEqual(["b", "a"]);
    expect(result.afterItem.card.reps).toBe(1);
    expect(result.session.queue.at(-1).card).toEqual(result.afterItem.card);
  });

  it("advances after a non-Again rating with a full before-and-after snapshot", () => {
    const session = startReviewSession(words, 20, now);
    const result = rateSessionCard(session, Rating.Good, now);
    expect(result.session.completed).toBe(1);
    expect(result.beforeItem).toEqual(currentReviewItem(session));
    expect(result.afterItem).toEqual({ ...currentReviewItem(session), card: result.afterItem.card });
    expect(result.afterItem.card.reps).toBe(1);
    expect(currentReviewItem(result.session).id).toBe("b");
  });

  it("undoes both the queue and the whole learning item", () => {
    const session = startReviewSession(words, 20, now);
    const rated = rateSessionCard(session, Rating.Good, now);
    const undone = undoReviewSession(rated.session);
    expect(undone.session.completed).toBe(0);
    expect(currentReviewItem(undone.session).id).toBe("a");
    expect(undone.beforeItem).toEqual(currentReviewItem(session));
  });

  it("masters the current card and undoes the whole item", () => {
    const session = startReviewSession(words, 20, now);
    const mastered = masterSessionCard(session, now);
    expect(mastered.beforeItem.learningState).toBe("learning");
    expect(mastered.afterItem.learningState).toBe("mastered");
    expect(mastered.afterItem.masteredAt).toBe(now.toISOString());
    expect(currentReviewItem(mastered.session).id).toBe("b");
    expect(mastered.session.completed).toBe(1);
    const undone = undoReviewSession(mastered.session);
    expect(undone.beforeItem.learningState).toBe("learning");
    expect(currentReviewItem(undone.session).id).toBe("a");
  });
});

describe("learning screens", () => {
  it("keeps the Chinese answer and ratings hidden during initial recall", () => {
    const html = renderToStaticMarkup(React.createElement(ReviewSession, {
      items: words,
      reviewLimit: 20,
      onReview: () => {},
      onExit: () => {},
      onOpen: () => {},
      catalog: [],
    }));
    expect(html).toContain("认识");
    expect(html).toContain("不认识");
    expect(html).toContain("Trees give shade.");
    expect(html).not.toContain(">树荫<");
    expect(html).not.toContain("记错");
    expect(html).toContain("撤销");
  });

  it("shows every due word, the current batch size, and separate vocabulary views", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: `learning-${index}`,
      word: `word-${index}`,
      sentence: "A sentence.",
      translation: "译义",
      learningState: "learning",
      masteredAt: null,
      card: { due: "2020-01-01T00:00:00.000Z" },
    }));
    items.push({ ...items[0], id: "mastered", word: "branch", learningState: "mastered" });
    const html = renderToStaticMarkup(React.createElement(VocabularyScreen, {
      items,
      reviewLimit: 10,
      reviewing: false,
      onChange: () => {},
      onReview: () => {},
      onOpen: () => {},
      onReviewingChange: () => {},
      catalog: [],
    }));

    expect(html).toContain("待复习");
    expect(html).toContain("已掌握");
    expect(html).toContain("12 张待复习");
    expect(html).toContain("本批 10 张");
    expect(html).not.toContain(">branch<");
  });

  it("restores a mastered word from the actual vocabulary view", async () => {
    const items = [{
      id: "mastered",
      word: "branch",
      sentence: "A branch provides shade.",
      translation: "树枝",
      learningState: "mastered",
      masteredAt: "2026-11-01T00:00:00.000Z",
      card: { due: "2027-01-01T00:00:00.000Z" },
    }];
    let changed;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(VocabularyScreen, {
      items,
      reviewing: false,
      onChange: (next) => { changed = next; },
      onReview: () => {},
      onOpen: () => {},
      onReviewingChange: () => {},
      catalog: [],
    })));
    const masteredTab = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("已掌握"));
    await act(async () => masteredTab.click());
    expect(container.textContent).toContain("恢复复习");

    const restore = [...container.querySelectorAll("button")].find((button) => button.textContent === "恢复复习");
    await act(async () => restore.click());
    expect(changed).toHaveLength(1);
    expect(changed[0].learningState).toBe("learning");
    expect(changed[0].masteredAt).toBeNull();
    expect(new Date(changed[0].card.due).getTime()).toBeLessThanOrEqual(Date.now());
    await act(async () => root.unmount());
    container.remove();
  });

  it("undoes the final rating with a touch-accessible completion button", async () => {
    let latest;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(ReviewSession, {
      items: [words[0]],
      onReview: (_item, _rating, snapshot) => { latest = snapshot; },
      onExit: () => {},
      onOpen: () => {},
      catalog: [],
    })));
    await act(async () => container.querySelector(".review-recall .primary-button").click());
    await act(async () => container.querySelector(".rating-good").click());
    expect(container.textContent).toContain("本批完成");
    const undo = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("撤销"));
    expect(undo).toBeTruthy();

    await act(async () => undo.click());
    expect(container.querySelector(".review-card").textContent).toContain("shade");
    expect(latest.learningState).toBe("learning");
    expect(latest.card.reps).toBe(0);
    await act(async () => root.unmount());
    container.remove();
  });

  it("undoes mastering the final card from the completion view", async () => {
    let latest;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(ReviewSession, {
      items: [words[0]],
      onReview: (_item, _rating, snapshot) => { latest = snapshot; },
      onExit: () => {},
      onOpen: () => {},
      catalog: [],
    })));
    await act(async () => container.querySelector(".review-recall .primary-button").click());
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "移入已掌握").click();
    });
    expect(container.textContent).toContain("本批完成");
    const undo = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("撤销"));
    expect(undo).toBeTruthy();

    await act(async () => undo.click());
    expect(container.querySelector(".review-card").textContent).toContain("shade");
    expect(latest.learningState).toBe("learning");
    expect(latest.masteredAt).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });

  it("offers another batch when due words remain after this session", () => {
    const html = renderToStaticMarkup(React.createElement(ReviewSession, {
      items: [],
      remainingDue: 24,
      onNextBatch: () => {},
      onReview: () => {},
      onExit: () => {},
      onOpen: () => {},
      catalog: [],
    }));
    expect(html).toContain("还有 24 张到期生词");
    expect(html).toContain("复习下一批");
  });

  it("offers article review and an optional level adjustment", () => {
    const html = renderToStaticMarkup(React.createElement(ReadingCompletion, {
      article: { id: "a", title: "Trees", cefr: "B1" },
      vocabularyCount: 2,
      feedback: "hard",
      onFeedback: () => {},
      onReview: () => {},
      onAdjustLevel: () => {},
      onBack: () => {},
    }));
    expect(html).toContain("复习本文 2 个生词");
    expect(html).toContain("太难");
    expect(html).toContain("A2");
  });
});
