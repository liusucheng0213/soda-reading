// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EXAM_TRACK_LABELS, examOriginLabel, filterExamArticles } from "./exams.js";
import { LibraryScreen } from "../App.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const articles = [
  { id: "ordinary", title: "Ordinary Article", cefr: "B1", paragraphs: ["A complete paragraph."] },
  { id: "cet4", title: "CET4 Practice", examTrack: "cet4", contentOrigin: "official_exam", cefr: "B1", paragraphs: ["A complete paragraph."] },
  { id: "cet6", title: "CET6 Practice", examTrack: "cet6", contentOrigin: "original", cefr: "B2", paragraphs: ["A complete paragraph."] },
  { id: "postgraduate", title: "Postgraduate Practice", examTrack: "postgraduate", contentOrigin: "adapted", cefr: "C1", paragraphs: ["A complete paragraph."] },
];

let root;
let container;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("exam catalog helpers", () => {
  it("keeps exam tracks separate from CEFR and labels provenance honestly", () => {
    expect(EXAM_TRACK_LABELS.cet4).toBe("CET4");
    expect(EXAM_TRACK_LABELS.cet6).toBe("CET6");
    expect(EXAM_TRACK_LABELS.postgraduate).toBe("考研");
    expect(examOriginLabel({ contentOrigin: "official_exam" })).toBe("真题");
    expect(examOriginLabel({ contentOrigin: "licensed_exam" })).toBe("真题");
    expect(examOriginLabel({ contentOrigin: "adapted" })).toBe("改编");
    expect(examOriginLabel({ contentOrigin: "original" })).toBe("原创模拟");
    expect(examOriginLabel({ contentOrigin: null })).toBe("");

    expect(filterExamArticles(articles, "cet4").map((article) => article.id)).toEqual(["cet4"]);
    expect(filterExamArticles(articles, "all")).toHaveLength(3);
    expect(articles[0].cefr).toBe("B1");
    expect(articles[1].cefr).toBe("B1");
  });

  it("filters the shelf without removing ordinary catalog content", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(LibraryScreen, {
      documents: [], catalog: [articles[0]], examCatalog: articles.slice(1), examError: "",
      progress: {}, onDocumentsChange: () => {}, onOpen: () => {}, closedArticleId: "",
    })));
    expect(container.textContent).toContain("Ordinary Article");
    expect(container.textContent).toContain("CET4 Practice");
    expect(container.textContent).toContain("原创模拟");

    const cet4 = [...container.querySelectorAll("button")].find((button) => button.textContent === "CET4");
    await act(async () => cet4.click());
    expect(container.textContent).toContain("CET4 Practice");
    expect(container.textContent).not.toContain("CET6 Practice");
    expect(container.textContent).toContain("Ordinary Article");
    expect(cet4.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the normal shelf usable when the exam API is unavailable", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(LibraryScreen, {
      documents: [], catalog: [articles[0]], examCatalog: [], examError: "offline",
      progress: {}, onDocumentsChange: () => {}, onOpen: () => {}, closedArticleId: "",
    })));
    expect(container.textContent).toContain("Ordinary Article");
    expect(container.textContent).toContain("备考内容暂时无法加载，其他馆藏仍可使用");
    expect(container.textContent).not.toContain("CET4 Practice");
  });
});
