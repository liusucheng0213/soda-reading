import { describe, expect, it } from "vitest";
import { articleWithBody, displayFeed, rankArticles } from "./feed.js";

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

  it("keeps a live exact match as today's piece", () => {
    const feed = { primary: library[1], alternatives: [library[2]] };
    const shown = displayFeed(feed, { level: "B1", topics: [] }, []);
    expect(shown.primary.id).toBe("b1");
    expect(shown.standby).toBe(false);
    expect(shown.exactMatch).toBe(true);
  });

  it("marks a failed feed as standby even when the level matches", () => {
    const feed = { primary: library[1], alternatives: [library[0]], fallback: true };
    const shown = displayFeed(feed, { level: "B1" }, library);
    expect(shown.standby).toBe(true);
    expect(shown.primary.id).toBe("b1");
  });

  it("keeps an injected piece marked as standby when the homepage ranks the feed again", () => {
    const raw = { primary: library[1], alternatives: [library[2]] };
    const once = displayFeed(raw, { level: "A2" }, library);
    const twice = displayFeed(once, { level: "A2" }, library);
    expect(twice.primary.id).toBe("a2");
    expect(twice.standby).toBe(true);
    const back = displayFeed(once, { level: "B1" }, library);
    expect(back.primary.id).toBe("b1");
    expect(back.standby).toBe(false);
  });

  it("marks an injected library piece as standby", () => {
    const feed = { primary: library[1], alternatives: [library[2]] };
    const shown = displayFeed(feed, { level: "A2", topics: ["自然"] }, library);
    expect(shown.primary.id).toBe("a2");
    expect(shown.standby).toBe(true);
  });

  it("returns no alternatives when the pool has a single article", () => {
    const only = { id: "solo", title: "Solo", cefr: "B1", topic: "文化", paragraphs: ["Only."] };
    const shown = displayFeed({ primary: only, alternatives: [] }, { level: "B1" }, []);
    expect(shown.alternatives).toEqual([]);
  });

  it("replaces a body-less exact match with a readable library piece", () => {
    const shell = { id: "shell", title: "Shell", cefr: "A2", paragraphs: [] };
    const shown = displayFeed({ primary: shell, alternatives: [] }, { level: "A2" }, library);
    expect(shown.primary.id).toBe("a2");
    expect(shown.alternatives.map((item) => item.id)).toContain("shell");
    expect(shown.exactMatch).toBe(true);
  });

  it("keeps a body-less article visible when nothing readable exists at that level", () => {
    const shell = { id: "shell", title: "Shell", cefr: "A2", paragraphs: [] };
    const shown = displayFeed({ primary: shell, alternatives: [] }, { level: "A2" }, []);
    expect(shown.primary.id).toBe("shell");
    expect(shown.exactMatch).toBe(false);
  });

  it("does not feature a library card that has no body", () => {
    const feed = { primary: library[1], alternatives: [] };
    const empty = { id: "empty-a2", title: "Empty", cefr: "A2", paragraphs: [] };
    expect(displayFeed(feed, { level: "A2" }, [empty, library[0]]).primary.id).toBe("a2");
    expect(displayFeed(feed, { level: "A2" }, [empty]).primary.id).toBe("b1");
  });

  it("fills a missing body only from the same article", () => {
    const shelf = [
      { id: "same", cefr: "B1", paragraphs: ["Hello."] },
      { id: "other", cefr: "B1", paragraphs: ["Different."] },
    ];
    expect(articleWithBody({ id: "same", cefr: "B1", title: "Same" }, shelf).paragraphs).toEqual(["Hello."]);
    expect(articleWithBody({ id: "empty", cefr: "B1", title: "Empty" }, shelf)).toMatchObject({ id: "empty", title: "Empty" });
    expect(articleWithBody({ id: "empty", cefr: "B1" }, shelf).paragraphs).toBeUndefined();
    expect(articleWithBody({ id: "kept", paragraphs: ["Own."] }, shelf).paragraphs).toEqual(["Own."]);
  });
});
