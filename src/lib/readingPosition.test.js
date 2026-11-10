import { describe, expect, it } from "vitest";
import { chapterOverallProgress, legacyLocationKeyForDocument, normalizeReadingPosition, updateReadingPosition, withChapterKey } from "./readingPosition.js";

const chapters = [
  { id: "chapter-0001", title: "One", paragraphs: ["one two three four"] },
  { id: "chapter-0002", title: "Two", paragraphs: ["five six seven eight"] },
];

describe("chapter reading positions", () => {
  it("weights whole-book progress by chapter word count", () => {
    expect(chapterOverallProgress(chapters, "chapter-0002", 0.5)).toBe(0.75);
    expect(chapterOverallProgress(chapters, "chapter-0001", 1)).toBe(0.5);
  });

  it("restores the saved chapter and its scroll ratio", () => {
    const position = normalizeReadingPosition({ chapters }, {
      chapterId: "chapter-0002",
      chapterProgress: 0.35,
      progress: 0.675,
    }, 0);
    expect(position).toMatchObject({ chapterId: "chapter-0002", chapterProgress: 0.35, progress: 0.675 });
  });

  it("maps legacy whole-document progress to a single chapter", () => {
    expect(normalizeReadingPosition({ chapters: [chapters[0]] }, null, 0.4)).toMatchObject({
      chapterId: "chapter-0001",
      chapterProgress: 0.4,
      progress: 0.4,
    });
  });

  it("keeps independent offsets when switching chapters", () => {
    const previous = { chapterId: "chapter-0001", chapterProgress: 0.6, progress: 0.3 };
    const next = updateReadingPosition(previous, chapters, "chapter-0002", 0.2);
    expect(next).toMatchObject({ chapterId: "chapter-0002", chapterProgress: 0.2, progress: 0.6 });
    expect(next.chapterOffsets).toEqual({ "chapter-0001": 0.6, "chapter-0002": 0.2 });
  });

  it("prefixes only legacy location keys", () => {
    expect(withChapterKey("0-1-2", "chapter-0002")).toBe("chapter-0002:0-1-2");
    expect(withChapterKey("chapter-0001:0-1-2", "chapter-0002")).toBe("chapter-0001:0-1-2");
  });
});


describe("legacy multi-chapter migration", () => {
  it("maps an old whole-book ratio to an approximate chapter and offset", () => {
    const position = normalizeReadingPosition({ chapters }, null, 0.75);
    expect(position).toMatchObject({ chapterId: "chapter-0002", chapterProgress: 0.5, progress: 0.75 });
    expect(position.chapterOffsets["chapter-0001"]).toBe(1);
  });

  it("maps old global paragraph keys into the correct chapter", () => {
    const document = {
      chapters: [
        { id: "chapter-0001", paragraphs: ["One.", "Two."] },
        { id: "chapter-0002", paragraphs: ["Three."] },
      ],
    };
    expect(legacyLocationKeyForDocument(document, "2-0-1")).toBe("chapter-0002:0-0-1");
  });
});
