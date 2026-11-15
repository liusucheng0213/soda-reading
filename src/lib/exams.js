export const EXAM_TRACK_LABELS = Object.freeze({
  high_school: "高中",
  cet4: "CET4",
  cet6: "CET6",
  postgraduate: "考研",
});

export function examOriginLabel(article) {
  return {
    official_exam: "真题",
    licensed_exam: "真题",
    adapted: "改编",
    original: "原创模拟",
  }[article?.contentOrigin] ?? "";
}

export function filterExamArticles(items, track = "all") {
  const exams = (Array.isArray(items) ? items : []).filter((article) => article?.examTrack);
  if (track === "all") return exams;
  return exams.filter((article) => article.examTrack === track);
}
