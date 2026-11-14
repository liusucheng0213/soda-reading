import { describe, expect, it } from "vitest";
import {
  currentReviewItem,
  dueCards,
  dueVocabulary,
  learningVocabulary,
  masteredVocabulary,
  setVocabularyLearningState,
  startReviewSession,
  vocabularyState,
} from "./review.js";

const now = new Date("2026-11-13T00:00:00.000Z");
const due = "2026-11-10T00:00:00.000Z";

function word(id, learningState = "learning", card = { due }) {
  return { id, word: id, learningState, masteredAt: null, card };
}

describe("vocabulary lifecycle", () => {
  it("separates learning and mastered words without changing their records", () => {
    const learning = word("shade");
    const mastered = word("branch", "mastered");
    const items = [learning, mastered];

    expect(vocabularyState(learning)).toBe("learning");
    expect(vocabularyState(mastered)).toBe("mastered");
    expect(learningVocabulary(items)).toEqual([learning]);
    expect(masteredVocabulary(items)).toEqual([mastered]);
    expect(learningVocabulary(items)).not.toBe(items);
    expect(items).toEqual([learning, mastered]);
  });

  it("returns every due learning card in order and only limits the display batch", () => {
    const items = Array.from({ length: 12 }, (_, index) => word(
      `word-${index}`,
      "learning",
      { due: new Date(now.getTime() - index * 60_000).toISOString() },
    ));
    items.push(word("mastered", "mastered"), word("future", "learning", { due: "2026-11-14T00:00:00.000Z" }));

    const allDue = dueVocabulary(items, now);
    expect(allDue).toHaveLength(12);
    expect(allDue.map((item) => item.id)).toEqual([...items.slice(0, 12)].reverse().map((item) => item.id));
    expect(dueCards(items, 10, now)).toHaveLength(10);
    expect(dueCards(items, 10, now).map((item) => item.id)).toEqual(allDue.slice(0, 10).map((item) => item.id));
  });

  it("masters a word while retaining its scheduling history", () => {
    const original = { ...word("shade"), card: { due, reps: 4, stability: 3.5 } };
    const result = setVocabularyLearningState(original, "mastered", now);

    expect(result).toMatchObject({
      id: "shade",
      learningState: "mastered",
      masteredAt: now.toISOString(),
      card: { due, reps: 4, stability: 3.5 },
    });
    expect(result).not.toBe(original);
    expect(result.card).not.toBe(original.card);
    expect(original.learningState).toBe("learning");
    expect(original.masteredAt).toBeNull();
  });

  it("restores a mastered word to an immediately due learning card", () => {
    const restored = setVocabularyLearningState(
      { ...word("shade", "mastered", { due: "2027-01-01T00:00:00.000Z" }), masteredAt: "2026-11-01T00:00:00.000Z" },
      "learning",
      now,
    );

    expect(restored.learningState).toBe("learning");
    expect(restored.masteredAt).toBeNull();
    expect(restored.card.due).toBe(now.toISOString());
  });

  it("rejects an unknown learning state", () => {
    expect(() => setVocabularyLearningState(word("shade"), "finished", now)).toThrow("生词状态");
  });

  it("starts review sessions with learning cards only", () => {
    const session = startReviewSession([word("shade"), word("branch", "mastered")], 20, now);
    expect(session.queue).toHaveLength(1);
    expect(currentReviewItem(session).id).toBe("shade");
  });
});
