export const LEVEL_ORDER = { A2: 0, B1: 1, B2: 2, C1: 3 };

export function uniqueArticles(articles) {
  const seen = new Set();
  const result = [];
  for (const article of articles) {
    if (!article?.id || seen.has(article.id)) continue;
    seen.add(article.id);
    result.push(article);
  }
  return result;
}

export function levelDistance(articleLevel, preferenceLevel) {
  return Math.abs((LEVEL_ORDER[articleLevel] ?? 1) - (LEVEL_ORDER[preferenceLevel] ?? 1));
}

export function rankArticles(articles, preferences = {}) {
  const level = preferences.level || "B1";
  const topics = preferences.topics || [];
  return [...articles].sort((left, right) => {
    const levelDelta = levelDistance(left.cefr, level) - levelDistance(right.cefr, level);
    if (levelDelta !== 0) return levelDelta;
    const interestDelta = Number(topics.includes(right.topic)) - Number(topics.includes(left.topic));
    if (interestDelta !== 0) return interestDelta;
    return (right.qualityScore ?? 0) - (left.qualityScore ?? 0);
  });
}

export function displayFeed(feed, preferences = {}, library = []) {
  const live = uniqueArticles([feed?.primary, ...(feed?.alternatives || [])]);
  const level = preferences.level || "B1";
  const hasExact = live.some((article) => article.cefr === level);
  const extras = hasExact ? [] : library.filter((article) => article.cefr === level);
  const ranked = rankArticles(uniqueArticles([...live, ...extras]), preferences);
  const primary = ranked[0] || feed?.primary || null;
  return {
    primary,
    alternatives: ranked.filter((article) => article.id !== primary?.id).slice(0, 4),
    exactMatch: primary?.cefr === level,
  };
}
