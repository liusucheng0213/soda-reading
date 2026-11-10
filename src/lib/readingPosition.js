import { normalizeChapters } from "@soda-reading/core";

function ratio(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function words(chapter) {
  return chapter.paragraphs.join(" ").trim().split(/\s+/).filter(Boolean).length;
}

export function withChapterKey(key, chapterId) {
  const value = String(key || "");
  return value.includes(":") ? value : `${chapterId}:${value}`;
}

export function chapterIdFromKey(key) {
  return String(key || "").includes(":") ? String(key).split(":")[0] : "";
}

export function chapterOverallProgress(chapters, chapterId, chapterProgress = 0) {
  const list = normalizeChapters({ chapters });
  const total = list.reduce((sum, chapter) => sum + words(chapter), 0);
  if (!total) return 0;
  const index = list.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) return 0;
  const before = list.slice(0, index).reduce((sum, chapter) => sum + words(chapter), 0);
  return ratio((before + words(list[index]) * ratio(chapterProgress)) / total);
}

export function legacyLocationKeyForDocument(document, key) {
  const value = String(key || "");
  if (value.includes(":")) return value;
  const chapters = normalizeChapters(document);
  const firstId = chapters[0]?.id || "chapter-0001";
  const parts = value.split("-");
  const globalParagraph = Number(parts[0]);
  if (!Number.isInteger(globalParagraph) || globalParagraph < 0) return withChapterKey(value, firstId);
  let offset = 0;
  for (const chapter of chapters) {
    const end = offset + chapter.paragraphs.length;
    if (globalParagraph < end) {
      return `${chapter.id}:${globalParagraph - offset}-${parts.slice(1).join("-")}`;
    }
    offset = end;
  }
  return withChapterKey(value, firstId);
}

export function normalizeReadingPosition(article, position, legacyProgress = 0) {
  const chapters = normalizeChapters(article);
  const firstId = chapters[0]?.id || "chapter-0001";
  const chapterOffsets = { ...(position?.chapterOffsets ?? {}) };
  let chapterId = chapters.some((chapter) => chapter.id === position?.chapterId) ? position.chapterId : firstId;
  let chapterProgress = ratio(position?.chapterProgress ?? 0);
  const overall = ratio(position?.progress ?? legacyProgress);
  if (!position && legacyProgress > 0) {
    if (chapters.length === 1) {
      chapterProgress = overall;
    } else {
      const total = chapters.reduce((sum, chapter) => sum + words(chapter), 0);
      let remaining = overall * total;
      for (let index = 0; index < chapters.length; index += 1) {
        const count = words(chapters[index]);
        if (remaining <= count || index === chapters.length - 1) {
          chapterId = chapters[index].id;
          chapterProgress = ratio(count ? remaining / count : 0);
          break;
        }
        chapterOffsets[chapters[index].id] = 1;
        remaining -= count;
      }
    }
  }
  return {
    chapterId,
    chapterProgress,
    progress: overall,
    chapterOffsets,
    updatedAt: position?.updatedAt ?? null,
  };
}

export function updateReadingPosition(previous, chapters, chapterId, chapterProgress) {
  const chapterOffsets = { ...(previous?.chapterOffsets ?? {}) };
  if (previous?.chapterId) chapterOffsets[previous.chapterId] = ratio(previous.chapterProgress);
  chapterOffsets[chapterId] = ratio(chapterProgress);
  return {
    chapterId,
    chapterProgress: ratio(chapterProgress),
    progress: chapterOverallProgress(chapters, chapterId, chapterProgress),
    chapterOffsets,
    updatedAt: new Date().toISOString(),
  };
}
