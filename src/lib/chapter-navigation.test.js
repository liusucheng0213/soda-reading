import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChapterNavigation } from "../screens/reader/ChapterNavigation.jsx";

describe("chapter navigation", () => {
  it("uses an ordered navigation list and marks the current chapter", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterNavigation, {
      chapters: [
        { id: "chapter-0001", title: "Opening", paragraphs: ["One two."] },
        { id: "chapter-0002", title: "Next", paragraphs: ["Three four."] },
      ],
      currentId: "chapter-0002",
      chapterOffsets: { "chapter-0001": 1 },
      onSelect: () => {},
    }));
    expect(html).toContain("章节目录");
    expect(html).toContain("<ol>");
    expect(html).toContain("aria-current=\"step\"");
    expect(html).toContain("已读完");
  });
});
