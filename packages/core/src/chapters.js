function paragraphs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
}

function chapterId(index) {
  return `chapter-${String(index + 1).padStart(4, "0")}`;
}

export function normalizeChapters(document) {
  const source = Array.isArray(document?.chapters) && document.chapters.length
    ? document.chapters
    : [{ title: "全文", paragraphs: document?.paragraphs ?? [] }];
  return source.map((chapter, index) => {
    const structured = chapter && typeof chapter === "object";
    const result = {
      id: structured && chapter.id ? String(chapter.id) : chapterId(index),
      title: structured && chapter.title ? String(chapter.title) : source.length === 1 ? "全文" : `第 ${index + 1} 章`,
      paragraphs: paragraphs(structured ? chapter.paragraphs ?? chapter.text : chapter),
    };
    if (structured && chapter.source) result.source = chapter.source;
    return result;
  }).filter((chapter) => chapter.paragraphs.length);
}

export function flattenChapters(chapters) {
  return (chapters ?? []).flatMap((chapter, chapterIndex) =>
    chapter.paragraphs.map((text, paragraphIndex) => ({
      text,
      chapterId: chapter.id,
      chapterIndex,
      paragraphIndex,
    }))
  );
}

const CHAPTER_HEADING = /^(?:(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+)\b.*|第[\d零〇一二三四五六七八九十百千]+[章节卷部](?:\s.*)?)$/i;

export function splitTextIntoChapters(text) {
  const lines = String(text || "").split(/\r?\n/);
  const found = [];
  let title = "全文";
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) found.push({ title, paragraphs: paragraphs(body) });
    buffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (CHAPTER_HEADING.test(trimmed)) {
      flush();
      title = trimmed;
    } else {
      buffer.push(line);
    }
  }
  flush();
  if (!found.length && String(text || "").trim()) {
    found.push({ title: "全文", paragraphs: paragraphs(text) });
  }
  return found.map((chapter, index) => ({ ...chapter, id: chapterId(index) }));
}

export function chaptersFromPages(pages) {
  return (pages ?? []).flatMap((page, index) => {
    const content = paragraphs(page);
    if (!content.length) return [];
    return [{
      id: chapterId(index),
      title: `第 ${index + 1} 页`,
      paragraphs: content,
      source: { page: index + 1 },
    }];
  });
}
