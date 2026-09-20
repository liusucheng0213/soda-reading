import { describe, expect, it } from "vitest";
import { displayFeed, rankArticles } from "./feed.js";

const library = [
  { id: "a2", title: "Trees", cefr: "A2", topic: "自然", qualityScore: 80, paragraphs: ["A"] },
  { id: "b1", title: "Books", cefr: "B1", topic: "文化", qualityScore: 90, paragraphs: ["B"] },
  { id: "b2", title: "Ocean", cefr: "B2", topic: "科技", qualityScore: 84, paragraphs: ["C"] },
  { id: "c1", title: "Libraries", cefr: "C1", topic: "文化", qualityScore: 86, paragraphs: ["D"] },
];

describe("feed matching", () => {
  it("puts the exact CEFR article first even when topics differ", () => {
    const ranked = rankArticles(library, { level: "A2", topics: ["文化"] });
    expect(ranked[0].id).toBe("a2");
  });

  it("rebuilds the homepage when the reader switches from A2 to B2", () => {
    const feed = { primary: library[1], alternatives: [library[0], library[2]] };
    const a2 = displayFeed(feed, { level: "A2", topics: ["文化"] }, library);
    const b2 = displayFeed(feed, { level: "B2", topics: ["文化"] }, library);
    expect(a2.primary.id).toBe("a2");
    expect(b2.primary.id).toBe("b2");
    expect(a2.primary.id).not.toBe(b2.primary.id);
  });

  it("can also land on C1 when that level is chosen", () => {
    const feed = { primary: library[1], alternatives: [library[0], library[2]] };
    const c1 = displayFeed(feed, { level: "C1", topics: ["科技"] }, library);
    expect(c1.primary.id).toBe("c1");
  });
});
