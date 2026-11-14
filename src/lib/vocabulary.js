import {
  cardFromRow,
  isSameVocabularyItem,
  newReviewCard,
  serializeCard,
  setVocabularyLearningState,
  vocabularyItemId,
  vocabularyState,
} from "@soda-reading/core";

export function upsertVocabularyItem(items, candidate, now = new Date()) {
  const current = items ?? [];
  const hasMeaning = typeof candidate?.translation === "string" && candidate.translation.trim();
  if (!candidate?.word || !hasMeaning) return current;
  const contentId = candidate.contentId ?? candidate.contentHash ?? "";
  const existing = current.find((item) => isSameVocabularyItem(item, contentId, candidate.word, candidate.sentence));
  if (existing) {
    if (vocabularyState(existing) === "learning") return current;
    return current.map((item) => item === existing ? setVocabularyLearningState(item, "learning", now) : item);
  }
  const card = candidate.card ?? newReviewCard(now);
  return [...current, {
    ...candidate,
    id: candidate.id ?? vocabularyItemId(contentId, candidate.word, candidate.sentence),
    learningState: "learning",
    masteredAt: null,
    card: serializeCard(cardFromRow(card)),
  }];
}
