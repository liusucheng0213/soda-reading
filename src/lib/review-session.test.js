import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { REVIEW_RATINGS, currentReviewItem, rateSessionCard, startReviewSession, undoReviewSession } from "@soda-reading/core";
import { ReviewSession } from "../screens/ReviewSession.jsx";
import { ReadingCompletion } from "../screens/ReadingCompletion.jsx";

const now = new Date("2026-11-10T08:00:00+08:00");
const words = [
  { id: "a", word: "shade", sentence: "Trees give shade.", translation: "树荫" },
  { id: "b", word: "curiosity", sentence: "Curiosity helps us learn.", translation: "好奇心" },
];

describe("review session state", () => {
  it("starts legacy saved words as new due cards", () => {
    const session = startReviewSession(words, 20, now);
    expect(session.total).toBe(2);
    expect(session.completed).toBe(0);
    expect(currentReviewItem(session).id).toBe("a");
    expect(currentReviewItem(session).card.due).toBe(now.toISOString());
  });

  it("requeues Again without counting the card complete", () => {
    const session = startReviewSession(words, 20, now);
    const result = rateSessionCard(session, Rating.Again, now);
    expect(result.session.completed).toBe(0);
    expect(result.session.queue.map((item) => item.id)).toEqual(["b", "a"]);
    expect(result.after.reps).toBe(1);
  });

  it("advances after a non-Again rating", () => {
    const session = startReviewSession(words, 20, now);
    const result = rateSessionCard(session, Rating.Good, now);
    expect(result.session.completed).toBe(1);
    expect(currentReviewItem(result.session).id).toBe("b");
  });

  it("undoes both the queue and the FSRS card state", () => {
    const session = startReviewSession(words, 20, now);
    const rated = rateSessionCard(session, Rating.Good, now);
    const undone = undoReviewSession(rated.session);
    expect(undone.session.completed).toBe(0);
    expect(currentReviewItem(undone.session).id).toBe("a");
    expect(undone.before).toEqual(currentReviewItem(session).card);
  });
});

describe("learning screens", () => {
  it("keeps the answer and ratings hidden until recall", () => {
    const html = renderToStaticMarkup(React.createElement(ReviewSession, {
      items: words,
      reviewLimit: 20,
      onReview: () => {},
      onExit: () => {},
      onOpen: () => {},
      catalog: [],
    }));
    expect(html).toContain("显示答案");
    expect(html).toContain("Trees give shade.");
    expect(html).not.toContain(">良好<");
    expect(html).toContain("撤销");
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
