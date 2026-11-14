import { masteredVocabulary, vocabularyState } from "@soda-reading/core";
import {
  listLocalDocuments,
  persistState,
  readAccountState,
  replaceLocalDocuments,
  useStoredState,
  writeAccountState,
} from "./storage.js";

const BUCKET_NAMES = [
  "resume",
  "vocabulary",
  "highlights",
  "progress",
  "readingDay",
  "positions",
  "articleFeedback",
  "placement",
];
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRatio(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateDocument(document) {
  if (!isRecord(document) || typeof document.id !== "string" || !document.id || typeof document.title !== "string") {
    throw new Error("备份中的书籍内容无效");
  }
  if (typeof document.importedAt !== "string" || typeof document.fileType !== "string" || !validStringArray(document.paragraphs)) {
    throw new Error("备份中的书籍内容无效");
  }
  if (typeof document.chapters !== "undefined") {
    if (!Array.isArray(document.chapters)) throw new Error("备份中的章节无效");
    const ids = new Set();
    for (const chapter of document.chapters) {
      if (!isRecord(chapter) || typeof chapter.id !== "string" || typeof chapter.title !== "string" || !validStringArray(chapter.paragraphs)) {
        throw new Error("备份中的章节无效");
      }
      if (ids.has(chapter.id)) throw new Error("备份中的章节 ID 重复");
      ids.add(chapter.id);
    }
  }
}

function validateVocabulary(items) {
  if (!Array.isArray(items)) throw new Error("备份中的生词无效");
  for (const item of items) {
    if (!isRecord(item) || ["id", "word", "sentence"].some((field) => typeof item[field] !== "string")) {
      throw new Error("备份中的生词无效");
    }
    if (typeof item.translation !== "string" || !item.translation.trim()) {
      throw new Error("备份中的生词无效");
    }
    if (typeof item.referent !== "undefined" && typeof item.referent !== "boolean") {
      throw new Error("备份中的生词指代标记无效");
    }
    if (!["learning", "mastered"].includes(item.learningState)) throw new Error("备份中的生词状态无效");
    const masteredAtValid = typeof item.masteredAt === "string" && !Number.isNaN(Date.parse(item.masteredAt));
    if (item.learningState === "mastered" ? !masteredAtValid : item.masteredAt !== null) {
      throw new Error("备份中的生词掌握时间无效");
    }
    for (const field of ["contentId", "contentHash", "chapterId"]) {
      if (item[field] != null && typeof item[field] !== "string") throw new Error("备份中的生词无效");
    }
    if (item.card != null) {
      if (!isRecord(item.card) || typeof item.card.due !== "string" || Number.isNaN(Date.parse(item.card.due))) {
        throw new Error("备份中的复习卡片无效");
      }
      for (const [field, value] of Object.entries(item.card)) {
        if (["reps", "lapses", "stability", "difficulty"].includes(field) && typeof value !== "number") {
          throw new Error("备份中的复习卡片无效");
        }
      }
    }
  }
}

function validateHighlights(items) {
  if (!Array.isArray(items)) throw new Error("备份中的划线无效");
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.articleId !== "string" || typeof item.sentence !== "string" || !validStringArray(item.keys)) {
      throw new Error("备份中的划线无效");
    }
  }
}

function validateBuckets(buckets) {
  for (const name of BUCKET_NAMES) {
    if (!Object.hasOwn(buckets, name)) throw new Error(`备份缺少 ${name} 学习数据`);
  }
  if (buckets.resume !== null && (!isRecord(buckets.resume) || typeof buckets.resume.id !== "string")) throw new Error("备份中的 resume 无效");
  validateVocabulary(buckets.vocabulary);
  validateHighlights(buckets.highlights);
  if (!isRecord(buckets.progress) || !Object.values(buckets.progress).every(validRatio)) throw new Error("备份中的阅读进度无效");
  if (buckets.readingDay !== null && (!isRecord(buckets.readingDay) || typeof buckets.readingDay.date !== "string" || typeof buckets.readingDay.minutes !== "number")) {
    throw new Error("备份中的 readingDay 无效");
  }
  if (!isRecord(buckets.positions)) throw new Error("备份中的阅读位置无效");
  for (const position of Object.values(buckets.positions)) {
    if (!isRecord(position) || typeof position.chapterId !== "string" || !validRatio(position.chapterProgress) || !validRatio(position.progress)) {
      throw new Error("备份中的阅读位置无效");
    }
    if (position.chapterOffsets != null && (!isRecord(position.chapterOffsets) || !Object.values(position.chapterOffsets).every(validRatio))) {
      throw new Error("备份中的阅读位置无效");
    }
  }
  if (!isRecord(buckets.articleFeedback)) throw new Error("备份中的难度反馈无效");
  for (const feedback of Object.values(buckets.articleFeedback)) {
    if (!isRecord(feedback) || !["easy", "right", "hard"].includes(feedback.feeling) || typeof feedback.updatedAt !== "string") {
      throw new Error("备份中的难度反馈无效");
    }
  }
  if (buckets.placement !== null && (!isRecord(buckets.placement) || !LEVELS.includes(buckets.placement.level) || !isRecord(buckets.placement.perLevel) || typeof buckets.placement.answered !== "number" || typeof buckets.placement.correct !== "number")) {
    throw new Error("备份中的水平测试无效");
  }
}

export function buildBackup({ profile, readingPrefs, theme, buckets, documents }) {
  return clone({
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    profile,
    readingPrefs,
    theme,
    buckets: {
      ...buckets,
      vocabulary: (buckets.vocabulary ?? []).map((item) => ({
        ...item,
        learningState: vocabularyState(item),
        masteredAt: item.masteredAt ?? null,
      })),
    },
    documents,
  });
}

export function parseBackup(text) {
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  if (!isRecord(backup) || backup.schemaVersion !== 2) throw new Error("不支持这个备份版本");
  if (typeof backup.exportedAt !== "string" || Number.isNaN(Date.parse(backup.exportedAt))) throw new Error("备份日期无效");
  if (!isRecord(backup.profile) || typeof backup.profile.username !== "string" || !LEVELS.includes(backup.profile.level) || !validStringArray(backup.profile.topics) || typeof backup.profile.minutes !== "number" || typeof backup.profile.reviewLimit !== "number" || typeof backup.profile.onboarded !== "boolean") {
    throw new Error("备份中的个人设置无效");
  }
  if (!isRecord(backup.readingPrefs) || typeof backup.readingPrefs.typeface !== "string" || typeof backup.readingPrefs.fontScale !== "number" || typeof backup.readingPrefs.lineHeight !== "number" || typeof backup.readingPrefs.measure !== "string") {
    throw new Error("备份中的阅读设置无效");
  }
  if (!["day", "sepia", "night"].includes(backup.theme)) throw new Error("备份中的主题无效");
  if (!isRecord(backup.buckets)) throw new Error("备份中的学习数据无效");
  validateBuckets(backup.buckets);
  if (!Array.isArray(backup.documents)) throw new Error("备份中的书籍列表无效");
  for (const document of backup.documents) validateDocument(document);
  for (const name of Object.keys(backup.buckets)) {
    if (!BUCKET_NAMES.includes(name)) throw new Error("备份中的学习数据无效");
  }
  return {
    backup,
    summary: {
      documents: backup.documents.length,
      vocabulary: backup.buckets.vocabulary.length,
      mastered: masteredVocabulary(backup.buckets.vocabulary).length,
      highlights: backup.buckets.highlights.length,
    },
  };
}

function fallbackForBucket(name) {
  if (name === "resume" || name === "placement" || name === "readingDay") return null;
  if (name === "vocabulary" || name === "highlights") return [];
  return {};
}

const browserAdapter = {
  async snapshot() {
    const buckets = Object.fromEntries(BUCKET_NAMES.map((name) => [
      name,
      readAccountState("local", name, fallbackForBucket(name)),
    ]));
    return buildBackup({
      profile: useStoredState("soda.profile", null),
      readingPrefs: useStoredState("soda.readingPrefs", {}),
      theme: useStoredState("soda.theme", "day"),
      buckets,
      documents: await listLocalDocuments(),
    });
  },
  async restore(backup) {
    persistState("soda.profile", backup.profile);
    persistState("soda.readingPrefs", backup.readingPrefs);
    persistState("soda.theme", backup.theme);
    for (const name of BUCKET_NAMES) writeAccountState("local", name, backup.buckets[name]);
    await replaceLocalDocuments(backup.documents);
  },
};

export async function exportLocalData() {
  return browserAdapter.snapshot();
}

export function restoreErrorMessage(error) {
  if (error instanceof AggregateError || error?.name === "AggregateError") {
    return "恢复失败，且无法完整回滚；当前数据可能处于部分恢复状态，请立即停止继续写入并保留备份。";
  }
  return "恢复未完成，原有数据已保留或恢复";
}

export async function restoreLocalData(backup, adapter = browserAdapter) {
  const { backup: validated } = parseBackup(JSON.stringify(backup));
  const previous = await adapter.snapshot();
  try {
    await adapter.restore(validated);
    return validated;
  } catch (error) {
    try {
      await adapter.restore(previous);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "恢复失败，且无法完整回滚");
    }
    throw error;
  }
}
