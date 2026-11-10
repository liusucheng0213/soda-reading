const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function scorePlacement(answers = {}, questions = []) {
  const perLevel = Object.fromEntries(LEVELS.map((level) => [level, { correct: 0, answered: 0, total: 0 }]));
  let answered = 0;
  let correct = 0;
  for (const question of questions) {
    if (!perLevel[question.level]) continue;
    const stats = perLevel[question.level];
    stats.total += 1;
    const answer = answers[question.id];
    if (answer == null) continue;
    stats.answered += 1;
    answered += 1;
    if (answer === question.answer) {
      stats.correct += 1;
      correct += 1;
    }
  }

  let level = "A1";
  for (let index = 1; index < LEVELS.length; index += 1) {
    const current = LEVELS[index];
    const foundations = LEVELS.slice(0, index).every((lower) => perLevel[lower].correct >= 2);
    if (foundations && perLevel[current].correct >= 2) level = current;
  }
  return {
    level,
    perLevel,
    answered,
    correct,
    caveat: "这是基于少量题目的大致估计，只用于选择起步阅读材料。",
  };
}
