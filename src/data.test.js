import { articleForLevel } from "@soda-reading/core";
import { describe, expect, it } from "vitest";
import { fallbackLibrary } from "./data.js";
import { splitSentences } from "./lib/reader.js";

describe("bundled reading texts", () => {
  it("has an offline Chinese translation for every sentence", () => {
    const missing = [];
    for (const article of fallbackLibrary) {
      for (const paragraph of article.paragraphs) {
        for (const sentence of splitSentences(paragraph)) {
          if (!article.sentenceTranslations?.[sentence]) missing.push(`${article.id}: ${sentence}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("injects a full library piece when the live pool has no article at that level", () => {
    const live = [{ id: "news", cefr: "B1", paragraphs: ["News."] }];
    expect(articleForLevel(live, fallbackLibrary, "B1").article.id).toBe("news");
    expect(articleForLevel(live, fallbackLibrary, "C1")).toMatchObject({
      injected: true,
      article: { id: "public-libraries-20260718", cefr: "C1" },
    });
    expect(articleForLevel([{ id: "empty", cefr: "A2", paragraphs: [] }], fallbackLibrary, "A2").article.id).toBe("urban-trees-20260720");
    expect(articleForLevel([{ id: "empty", cefr: "A2", paragraphs: [] }], [], "A2").article.id).toBe("empty");
  });
});
