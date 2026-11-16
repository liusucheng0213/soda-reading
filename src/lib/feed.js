export const LEVEL_ORDER = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };

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

function trackScore(article, track) {
  if (track !== "high_school") return 0;
  if (article?.examTrack === "high_school") return 2;
  return article?.examTrack ? 0 : 1;
}

function isDailyArticle(article) {
  return !article?.examTrack || article.examTrack === "high_school";
}

export function rankArticles(articles, preferences = {}) {
  const level = preferences.level || "B1";
  const topics = preferences.topics || [];
  const track = preferences.track || "daily";
  return [...articles].sort((left, right) => {
    const levelDelta = levelDistance(left.cefr, level) - levelDistance(right.cefr, level);
    if (levelDelta !== 0) return levelDelta;
    const trackDelta = trackScore(right, track) - trackScore(left, track);
    if (trackDelta !== 0) return trackDelta;
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
  const track = preferences.track || "daily";
  const live = uniqueArticles([source?.primary, ...(source?.alternatives || [])]).filter(isDailyArticle);
  const trackLive = track === "high_school"
    ? live.filter((article) => article.examTrack === "high_school")
    : live;
  const level = preferences.level || "B1";
  const readableLive = trackLive.filter(hasBody);
  const hasExact = readableLive.some((article) => article.cefr === level);
  const extras = hasExact
    ? []
    : (library || []).filter((article) => isDailyArticle(article) && article.cefr === level && hasBody(article));
  const ranked = rankArticles(uniqueArticles([...readableLive, ...extras]), preferences);
  const primary = ranked[0]
    || trackLive.find((article) => article.cefr === level)
    || readableLive[0]
    || trackLive[0]
    || null;
  const fromLive = Boolean(primary?.id && readableLive.some((article) => article.id === primary.id));
  const levelMatched = Boolean(primary?.cefr === level && hasBody(primary));
  const trackMatched = track !== "high_school" || primary?.examTrack === "high_school";
  return {
    primary,
    alternatives: uniqueArticles([
      ...ranked.filter((article) => article.id !== primary?.id),
      ...trackLive.filter((article) => !hasBody(article)),
    ]).slice(0, 4),
    exactMatch: levelMatched,
    trackMatched,
    standby: Boolean(source?.fallback) || !fromLive || !levelMatched || !trackMatched,
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
