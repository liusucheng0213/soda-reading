import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
} from "ts-fsrs";

const scheduler = fsrs(generatorParameters({
  enable_fuzz: true,
  enable_short_term: true,
}));

export const REVIEW_RATINGS = [
  { id: Rating.Again, key: "again", label: "忘记" },
  { id: Rating.Hard, key: "hard", label: "困难" },
  { id: Rating.Good, key: "good", label: "良好" },
  { id: Rating.Easy, key: "easy", label: "简单" },
];

export function newReviewCard(now = new Date()) {
  return createEmptyCard(now);
}

export function cardFromRow(row) {
  if (!row) return newReviewCard();
  return {
    due: new Date(row.due),
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    elapsed_days: Number(row.elapsed_days ?? 0),
    scheduled_days: Number(row.scheduled_days ?? 0),
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    learning_steps: Number(row.learning_steps ?? 0),
    state: Number(row.state ?? 0),
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

export function scheduleReview(row, rating, now = new Date()) {
  const before = cardFromRow(row);
  const outcome = scheduler.next(before, now, rating);
  return {
    before: serializeCard(before),
    after: serializeCard(outcome.card),
    log: outcome.log,
  };
}

export function serializeCard(card) {
  return {
    due: card.due instanceof Date ? card.due.toISOString() : card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    learning_steps: card.learning_steps,
    state: card.state,
    last_review: card.last_review instanceof Date
      ? card.last_review.toISOString()
      : card.last_review ?? null,
  };
}

export function dueCards(items, limit = 20, now = new Date()) {
  return [...items]
    .filter((item) => !item.card?.due || new Date(item.card.due) <= now)
    .sort((left, right) =>
      new Date(left.card?.due ?? 0).getTime() - new Date(right.card?.due ?? 0).getTime()
    )
    .slice(0, Math.max(10, Math.min(50, limit)));
}
