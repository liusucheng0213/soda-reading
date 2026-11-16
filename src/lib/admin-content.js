const REJECTION_LABELS = Object.freeze({
  dangerous_instruction: "危险指导",
  hate_or_harassment: "仇恨或骚扰",
  explicit_content: "露骨内容",
  sensational_clickbait: "标题党",
  quality_below_65: "质量分不足",
  moderation_unavailable: "审核模型不可用",
  moderation_low_confidence: "审核置信度不足",
  moderation_run_limit: "超过本轮审核上限",
  ai_moderation_rejected: "AI 审核拒绝",
  insufficient_evidence_text: "证据摘要不足",
  unknown_license: "许可不明确",
});

export function duplicatePercent(run) {
  return `${Math.round((run?.duplicateRate ?? 0) * 100)}%`;
}

export function editionTrackCounts(run) {
  return {
    general: run?.editionCoverage?.tracks?.general ?? 0,
    high_school: run?.editionCoverage?.tracks?.high_school ?? 0,
  };
}

export function rejectionReasonRows(run) {
  return Object.entries(run?.moderationStats?.reasons ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

export function rejectionReasonLabel(code) {
  return REJECTION_LABELS[code] ?? code;
}
