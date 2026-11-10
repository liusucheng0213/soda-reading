import { describe, expect, it } from "vitest";
import { placementQuestions } from "../data/placementQuestions.js";
import { scorePlacement } from "./placement.js";

const levels = ["A1", "A2", "B1", "B2", "C1", "C2"];
const correctAnswers = () => Object.fromEntries(placementQuestions.map((question) => [question.id, question.answer]));

describe("placement question bank", () => {
  it("has three valid original questions at each CEFR level", () => {
    expect(new Set(placementQuestions.map((question) => question.id)).size).toBe(18);
    for (const level of levels) {
      const group = placementQuestions.filter((question) => question.level === level);
      expect(group).toHaveLength(3);
      for (const question of group) {
        expect(question.choices).toContain(question.answer);
        expect(new Set(question.choices).size).toBe(question.choices.length);
        expect(question.explanation.length).toBeGreaterThan(8);
      }
    }
  });
});

describe("placement scoring", () => {
  it("returns C2 for a fully correct test", () => {
    const result = scorePlacement(correctAnswers(), placementQuestions);
    expect(result).toMatchObject({ level: "C2", answered: 18, correct: 18 });
    expect(result.perLevel.C2).toEqual({ correct: 3, answered: 3, total: 3 });
    expect(result.caveat).toContain("大致");
  });

  it("uses A1 as the starting recommendation for empty or all-wrong answers", () => {
    expect(scorePlacement({}, placementQuestions)).toMatchObject({ level: "A1", answered: 0, correct: 0 });
    expect(scorePlacement(Object.fromEntries(placementQuestions.map((question) => [question.id, "wrong"])), placementQuestions).level).toBe("A1");
  });

  it("does not assign a high level from isolated difficult answers", () => {
    const answers = Object.fromEntries(placementQuestions.filter((question) => ["C1", "C2"].includes(question.level)).map((question) => [question.id, question.answer]));
    expect(scorePlacement(answers, placementQuestions).level).toBe("A1");
  });

  it("stops at a missing intermediate foundation", () => {
    const answers = {};
    for (const question of placementQuestions) {
      answers[question.id] = question.level === "B2" ? "wrong" : question.answer;
    }
    expect(scorePlacement(answers, placementQuestions).level).toBe("B1");
  });

  it("counts skipped answers as unanswered rather than correct", () => {
    const first = placementQuestions[0];
    const result = scorePlacement({ [first.id]: null }, placementQuestions);
    expect(result.answered).toBe(0);
    expect(result.correct).toBe(0);
  });
});
