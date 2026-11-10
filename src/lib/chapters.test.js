import { describe, expect, it } from "vitest";
import { chaptersFromPages, flattenChapters, normalizeChapters, splitTextIntoChapters } from "@soda-reading/core";

describe("chapter normalization", () => {
  it("wraps legacy paragraphs as one readable chapter", () => {
    expect(normalizeChapters({ paragraphs: ["One paragraph.", "Another paragraph."] })).toEqual([{
      id: "chapter-0001",
      title: "全文",
      paragraphs: ["One paragraph.", "Another paragraph."],
    }]);
  });

  it("keeps legacy chapter text separate and creates stable ids", () => {
    const chapters = normalizeChapters({ chapters: ["First part.\n\nMore.", "Second part."] });
    expect(chapters.map((chapter) => chapter.id)).toEqual(["chapter-0001", "chapter-0002"]);
    expect(chapters[1].paragraphs).toEqual(["Second part."]);
  });

  it("flattens paragraphs with chapter-aware locations", () => {
    const flat = flattenChapters(normalizeChapters({ chapters: ["One.", "Two."] }));
    expect(flat).toEqual([
      { text: "One.", chapterId: "chapter-0001", chapterIndex: 0, paragraphIndex: 0 },
      { text: "Two.", chapterId: "chapter-0002", chapterIndex: 1, paragraphIndex: 0 },
    ]);
  });
});

describe("text and page chapters", () => {
  it("recognizes common English and Chinese chapter headings", () => {
    const chapters = splitTextIntoChapters("Chapter 1\nA beginning.\n\n第2章 继续\nAnother paragraph.");
    expect(chapters.map((chapter) => chapter.title)).toEqual(["Chapter 1", "第2章 继续"]);
    expect(chapters[0].paragraphs).toEqual(["A beginning."]);
    expect(chapters[1].paragraphs).toEqual(["Another paragraph."]);
  });

  it("does not invent chapters for plain text", () => {
    expect(splitTextIntoChapters("A simple title\n\nOne paragraph.")).toMatchObject([{ title: "全文" }]);
  });

  it("uses page numbers instead of inventing PDF chapter titles", () => {
    expect(chaptersFromPages(["Page one text.", "Page two text."])).toMatchObject([
      { title: "第 1 页", source: { page: 1 } },
      { title: "第 2 页", source: { page: 2 } },
    ]);
  });
});
