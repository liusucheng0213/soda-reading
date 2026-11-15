// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ExamPractice } from "../screens/ExamPractice.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const article = {
  id: "exam-practice-test",
  examTrack: "cet4",
  questions: [
    {
      id: "q1",
      prompt: "Which color is discussed?",
      options: ["Blue", "Green", "Red", "Yellow"],
      answer: "B",
      explanationZh: "原文明确指出讨论的是绿色。",
      evidenceParagraph: 0,
      evidenceSentence: "The green roof stayed cooler throughout the afternoon.",
    },
    {
      id: "q2",
      prompt: "What happened next?",
      options: ["They measured the roof", "They closed the window", "They bought a car", "They moved away"],
      answer: "A",
      explanationZh: "他们接着测量了屋顶。",
      evidenceParagraph: 1,
      evidenceSentence: "They measured the roof again on the following day.",
    },
  ],
};

let root;
let container;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(value) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(ExamPractice, { article: value })));
}

function option(label) {
  const item = [...container.querySelectorAll("label")].find((element) => element.textContent.includes(label));
  return item ? document.getElementById(item.htmlFor) : null;
}

function checkButton(questionId) {
  const fieldset = container.querySelector(`input[name$="-${questionId}"]`)?.closest("fieldset");
  return [...fieldset.querySelectorAll("button")].find((button) => button.textContent === "核对答案");
}

describe("exam reading practice", () => {
  it("hides answers until checking and hides them again after changing an answer", async () => {
    await render(article);
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(8);
    expect(container.textContent).not.toContain("正确答案");
    expect(container.textContent).not.toContain("原文明确指出");
    expect(container.querySelector(".exam-evidence")).toBeNull();
    expect(checkButton("q1").disabled).toBe(true);

    await act(async () => option("Red").click());
    expect(checkButton("q1").disabled).toBe(false);
    await act(async () => checkButton("q1").click());
    expect(container.textContent).toContain("回答错误");
    expect(container.textContent).toContain("正确答案：B. Green");
    expect(container.textContent).toContain("原文明确指出讨论的是绿色。");
    expect(container.textContent).toContain("The green roof stayed cooler throughout the afternoon.");
    expect(container.textContent).toContain("第 1 段");

    await act(async () => option("Green").click());
    expect(container.textContent).not.toContain("回答错误");
    expect(container.textContent).not.toContain("原文明确指出讨论的是绿色。");
    expect(container.querySelector(".exam-evidence")).toBeNull();
    await act(async () => checkButton("q1").click());
    expect(container.textContent).toContain("回答正确");
    expect(container.textContent).toContain("原文依据");
  });

  it("renders nothing for a normal article", async () => {
    await render({ id: "ordinary", examTrack: null, questions: [] });
    expect(container.innerHTML).toBe("");
  });
});
