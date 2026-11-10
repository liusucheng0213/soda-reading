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

function dueTime(item) {
  if (!item?.card?.due) return 0;
  const time = new Date(item.card.due).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function dueCards(items, limit = 20, now = new Date()) {
  const limitCount = Math.max(10, Math.min(50, Number(limit) || 20));
  return [...(items || [])]
    .filter((item) => dueTime(item) <= now.getTime())
    .sort((left, right) => dueTime(left) - dueTime(right))
    .slice(0, limitCount);
}

export function startReviewSession(items, limit = 20, now = new Date()) {
  const queue = dueCards(items, limit, now).map((item) => ({
    ...item,
    card: serializeCard(item.card ? cardFromRow(item.card) : newReviewCard(now)),
  }));
  return { queue, total: queue.length, completed: 0, history: [] };
}

export function currentReviewItem(session) {
  return session?.queue?.[0] ?? null;
}

export function rateSessionCard(session, rating, now = new Date()) {
  const item = currentReviewItem(session);
  if (!item) return { session, item: null, after: null, log: null };
  const outcome = scheduleReview(item.card, rating, now);
  const previous = {
    queue: [...session.queue],
    completed: session.completed,
  };
  const remaining = session.queue.slice(1);
  if (rating === Rating.Again) {
    const insertAt = Math.min(3, remaining.length);
    remaining.splice(insertAt, 0, { ...item, card: outcome.after });
  }
  return {
    ...outcome,
    item,
    session: {
      ...session,
      queue: remaining,
      completed: session.completed + (rating === Rating.Again ? 0 : 1),
      history: [...session.history, { ...previous, item, before: outcome.before }],
    },
  };
}

export function undoReviewSession(session) {
  const previous = session?.history?.at(-1);
  if (!previous) return null;
  return {
    session: {
      ...session,
      queue: previous.queue,
      completed: previous.completed,
      history: session.history.slice(0, -1),
    },
    item: previous.item,
    before: previous.before,
  };
}
