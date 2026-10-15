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

function hasBody(article) {
  return Boolean(article?.paragraphs?.length);
}

export function displayFeed(feed, preferences = {}, library = []) {
  const source = feed?.rawPrimary !== undefined || feed?.rawAlternatives
    ? { primary: feed.rawPrimary, alternatives: feed.rawAlternatives || [], fallback: feed.fallback }
    : feed;
  const live = uniqueArticles([source?.primary, ...(source?.alternatives || [])]);
  const level = preferences.level || "B1";
  const readableLive = live.filter(hasBody);
  const hasExact = readableLive.some((article) => article.cefr === level);
  const extras = hasExact ? [] : (library || []).filter((article) => article.cefr === level && hasBody(article));
  const ranked = rankArticles(uniqueArticles([...readableLive, ...extras]), preferences);
  const primary = ranked[0]
    || live.find((article) => article.cefr === level)
    || readableLive[0]
    || live[0]
    || null;
  const fromLive = Boolean(primary?.id && readableLive.some((article) => article.id === primary.id));
  const levelMatched = Boolean(primary?.cefr === level && hasBody(primary));
  return {
    primary,
    alternatives: uniqueArticles([
      ...ranked.filter((article) => article.id !== primary?.id),
      ...live.filter((article) => !hasBody(article)),
    ]).slice(0, 4),
    exactMatch: levelMatched,
    standby: Boolean(source?.fallback) || !fromLive || !levelMatched,
    fallback: Boolean(source?.fallback),
    rawPrimary: source?.primary ?? null,
    rawAlternatives: source?.alternatives ?? [],
  };
}

export function articleWithBody(article, library = []) {
  if (article?.paragraphs?.length) return article;
  const same = (library || []).find((item) => item?.id && item.id === article?.id && item.paragraphs?.length);
  return same || article || null;
}
