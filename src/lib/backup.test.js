import { describe, expect, it } from "vitest";
import { buildBackup, parseBackup, restoreErrorMessage, restoreLocalData } from "./backup.js";

const documents = [{
  id: "book-1",
  title: "Trees",
  paragraphs: ["Trees make shade."],
  chapters: [{ id: "chapter-0001", title: "全文", paragraphs: ["Trees make shade."] }],
  importedAt: "2026-11-10T00:00:00.000Z",
  fileType: "txt",
}];

function input() {
  return {
    profile: { username: "local", level: "B1", topics: ["自然"], minutes: 10, reviewLimit: 20, onboarded: true },
    readingPrefs: { typeface: "newsreader", fontScale: 1.12, lineHeight: 1.85, measure: "comfortable" },
    theme: "sepia",
    buckets: {
      resume: null,
      vocabulary: [{ id: "word-1", contentId: "book-1", word: "shade", sentence: "Trees make shade.", translation: "树荫", card: { due: "2026-11-10T00:00:00.000Z", reps: 1 } }],
      highlights: [],
      progress: { "book-1": 0.25 },
      readingDay: null,
      positions: { "book-1": { chapterId: "chapter-0001", chapterProgress: 0.25, progress: 0.25 } },
      articleFeedback: { "book-1": { feeling: "right", updatedAt: "2026-11-10T00:00:00.000Z" } },
      placement: null,
    },
    documents,
    session: { accessToken: "must-not-be-exported" },
  };
}

describe("local backup", () => {
  it("contains personal learning data and books without sessions or secrets", () => {
    const backup = buildBackup(input());
    expect(backup.schemaVersion).toBe(1);
    expect(backup.buckets.positions["book-1"].chapterId).toBe("chapter-0001");
    expect(backup.buckets.articleFeedback["book-1"].feeling).toBe("right");
    expect(backup.documents).toEqual(documents);
    expect(backup.session).toBeUndefined();
    expect(JSON.stringify(backup)).not.toContain("must-not-be-exported");
  });

  it("validates before reporting a restore summary", () => {
    const { backup, summary } = parseBackup(JSON.stringify(buildBackup(input())));
    expect(backup.profile.level).toBe("B1");
    expect(summary).toEqual({ documents: 1, vocabulary: 1, highlights: 0 });
  });

  it.each([
    ["not json", "不是有效的 JSON"],
    [JSON.stringify({ schemaVersion: 2 }), "不支持"],
    [JSON.stringify({ ...buildBackup(input()), documents: {} }), "书籍"],
    [JSON.stringify({ ...buildBackup(input()), buckets: [] }), "学习数据"],
  ])("rejects invalid input without restoring", (text, message) => {
    expect(() => parseBackup(text)).toThrow(message);
  });

  it.each(["resume", "vocabulary", "highlights", "progress", "readingDay", "positions", "articleFeedback", "placement"])("requires the %s bucket", (name) => {
    const backup = buildBackup(input());
    delete backup.buckets[name];
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(name);
  });

  it.each([
    [{ vocabulary: {} }, "生词"],
    [{ progress: { "book-1": "half" } }, "进度"],
    [{ positions: { "book-1": { chapterId: "chapter-0001", chapterProgress: "half" } } }, "位置"],
    [{ articleFeedback: { "book-1": { feeling: "unknown" } } }, "反馈"],
  ])("rejects wrong bucket value types", (patch, message) => {
    const backup = buildBackup(input());
    Object.assign(backup.buckets, patch);
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(message);
  });

  it.each([
    [{ importedAt: undefined }, "书籍"],
    [{ chapters: [{ id: "same", title: "One", paragraphs: ["One."] }, { id: "same", title: "Two", paragraphs: ["Two."] }] }, "章节"],
    [{ paragraphs: [42] }, "书籍"],
  ])("rejects malformed document data", (patch, message) => {
    const backup = buildBackup(input());
    backup.documents[0] = { ...backup.documents[0], ...patch };
    if (Object.hasOwn(patch, "importedAt")) delete backup.documents[0].importedAt;
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(message);
  });

  it("does not even snapshot current data for an invalid restore", async () => {
    const backup = buildBackup(input());
    delete backup.buckets.vocabulary;
    let called = false;
    await expect(restoreLocalData(backup, {
      snapshot: async () => { called = true; },
      restore: async () => {},
    })).rejects.toThrow("vocabulary");
    expect(called).toBe(false);
  });

  it("rolls back to the previous snapshot when a restore fails midway", async () => {
    const previous = buildBackup(input());
    const incoming = buildBackup({ ...input(), profile: { ...input().profile, level: "C2" }, documents: [] });
    let current = previous;
    let failed = false;
    const adapter = {
      snapshot: async () => current,
      restore: async (next) => {
        current = next;
        if (!failed && next.profile.level === "C2") {
          failed = true;
          throw new Error("quota");
        }
      },
    };
    await expect(restoreLocalData(incoming, adapter)).rejects.toThrow("quota");
    expect(current).toEqual(previous);
  });

  it("reports honestly when both restore and rollback fail", async () => {
    const backup = buildBackup(input());
    let error;
    await restoreLocalData(backup, {
      snapshot: async () => backup,
      restore: async () => { throw new Error("write failed"); },
    }).catch((cause) => { error = cause; });
    expect(error).toBeInstanceOf(AggregateError);
    expect(restoreErrorMessage(error)).toContain("无法完整回滚");
  });
});
