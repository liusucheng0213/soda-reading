import { AuthError, recordEdgeInvocation, requireUser } from "../_shared/auth.ts";
import { apiError, handleOptions, json } from "../_shared/http.ts";

type Article = {
  id: string;
  title: string;
  author: string;
  summary: string;
  paragraphs: string[];
  sentence_translations: Record<string, string>;
  glossary: Array<Record<string, unknown>>;
  cefr: string;
  reading_minutes: number;
  topic: string;
  content_mode: string;
  peer_review_status: string;
  quality_score: number;
  difficulty_metrics: Record<string, unknown>;
  source_published_at: string;
  sources: Array<{ label: string; url: string; publishedAt?: string }>;
  intro_zh?: string;
  published_at: string | null;
  created_at: string;
};

function articleSource(article: Article): string {
  const label = article.sources?.[0]?.label;
  if (article.content_mode !== "editorial_digest" && label) return label;
  return "苏打阅读编写";
}

function shanghaiDate(offsetDays = 0): string {
  const shifted = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const get = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function recencyScore(date: string): number {
  const days = Math.max(0, (Date.now() - new Date(date).getTime()) / 86_400_000);
  return Math.max(0, 1 - days / 365);
}

function score(
  article: Article,
  profile: { cefr: string; topics: string[] },
  recentIds: Set<string>,
  usedTopics: Set<string>,
): number {
  const interest = profile.topics.includes(article.topic) ? 1 : 0.25;
  const levels = ["A2", "B1", "B2", "C1"];
  const distance = Math.abs(levels.indexOf(profile.cefr) - levels.indexOf(article.cefr));
  const level = Math.max(0, 1 - distance * 0.4);
  const quality = Math.min(1, article.quality_score / 100);
  const diversity = usedTopics.has(article.topic) ? 0.4 : 1;
  const repeatPenalty = recentIds.has(article.id) ? 0.3 : 1;
  return (
    interest * 0.4 +
    level * 0.3 +
    recencyScore(article.source_published_at) * 0.15 +
    quality * 0.1 +
    diversity * 0.05
  ) * repeatPenalty;
}

function serialize(article: Article, recommendationScore: number, reason: string) {
  const sources = article.sources ?? [];
  return {
    id: article.id,
    title: article.title,
    author: article.author,
    source: articleSource(article),
    sourceMode: article.content_mode,
    contentMode: article.content_mode,
    sourceUrl: sources[0]?.url ?? "",
    publishedAt: article.published_at ?? article.created_at,
    sourcePublishedAt: article.source_published_at,
    cefr: article.cefr,
    readingMinutes: article.reading_minutes,
    topic: article.topic,
    summary: article.summary,
    introZh: String(article.intro_zh || article.summary || ""),
    paragraphs: article.paragraphs,
    sentenceTranslations: article.sentence_translations ?? {},
    glossary: article.glossary ?? [],
    sources,
    peerReviewStatus: article.peer_review_status,
    qualityScore: article.quality_score,
    difficultyMetrics: article.difficulty_metrics,
    recommendationScore,
    recommendationReason: reason,
  };
}

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "GET" && request.method !== "POST") {
    return apiError(request, 405, "METHOD_NOT_ALLOWED", "仅支持 GET");
  }
  try {
    const context = await requireUser(request);
    await recordEdgeInvocation(context.adminClient, "daily-feed");
    const today = shanghaiDate();
    const weekAgo = shanghaiDate(-7);
    const { data: edition } = await context.adminClient
      .from("daily_editions")
      .select("*")
      .eq("status", "published")
      .lte("edition_date", today)
      .gte("edition_date", weekAgo)
      .order("edition_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!edition) {
      return apiError(request, 503, "FEED_UNAVAILABLE", "推荐池正在准备，请稍后再试", true);
    }
    const editionArticleIds = Array.isArray(edition.article_ids) ? edition.article_ids : [];
    const { data: editionArticles, error: articleError } = await context.adminClient
      .from("article_variants")
      .select("*")
      .in("id", editionArticleIds)
      .eq("review_status", "approved");
    if (articleError) throw articleError;
    let articles = (editionArticles ?? []) as Article[];
    if (articles.length < 3) {
      const { data: fallback } = await context.adminClient
        .from("article_variants")
        .select("*")
        .eq("review_status", "approved")
        .gte("published_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
        .order("quality_score", { ascending: false })
        .limit(36);
      const byId = new Map([...articles, ...((fallback ?? []) as Article[])].map((item) => [item.id, item]));
      articles = [...byId.values()];
    }
    if (articles.length < 3) {
      return apiError(request, 503, "FEED_UNAVAILABLE", "合格文章不足，正在沿用本地缓存", true);
    }

    const { data: recentRows } = await context.adminClient
      .from("daily_recommendations")
      .select("primary_article_id,alternative_article_ids")
      .eq("user_id", context.user.id)
      .gte("recommendation_date", weekAgo)
      .lt("recommendation_date", today);
    const recentIds = new Set<string>();
    for (const row of recentRows ?? []) {
      recentIds.add(row.primary_article_id);
      for (const id of row.alternative_article_ids ?? []) recentIds.add(id);
    }
    const usedTopics = new Set<string>();
    const sorted = [...articles].sort((left, right) =>
      score(right, context.profile, recentIds, usedTopics) -
      score(left, context.profile, recentIds, usedTopics)
    );
    const exact = sorted.filter((article) => article.cefr === context.profile.cefr);
    const rest = sorted.filter((article) => article.cefr !== context.profile.cefr);
    const pool = [...exact, ...rest];
    const selected: Article[] = [];
    for (const article of pool) {
      if (selected.length >= 3) break;
      if (selected.length === 0 || !usedTopics.has(article.topic) || pool.length <= 4) {
        selected.push(article);
        usedTopics.add(article.topic);
      }
    }
    for (const article of pool) {
      if (selected.length >= 3) break;
      if (!selected.some((item) => item.id === article.id)) selected.push(article);
    }
    if (selected.length < 3) {
      return apiError(request, 503, "FEED_UNAVAILABLE", "合格文章不足，正在沿用本地缓存", true);
    }
    const scores = Object.fromEntries(
      selected.map((article) => [
        article.id,
        Number(score(article, context.profile, recentIds, new Set()).toFixed(4)),
      ]),
    );
    const reason = `匹配你的 ${context.profile.cefr} 水平与“${selected[0].topic}”兴趣`;
    await context.adminClient.from("daily_recommendations").upsert({
      user_id: context.user.id,
      recommendation_date: today,
      primary_article_id: selected[0].id,
      alternative_article_ids: selected.slice(1).map((article) => article.id),
      reasons: { primary: reason },
      scores,
    }, { onConflict: "user_id,recommendation_date" });

    return json(request, {
      primary: serialize(selected[0], scores[selected[0].id], reason),
      alternatives: selected.slice(1).map((article) =>
        serialize(article, scores[article.id], "最近 7 天的高质量匹配文章")
      ),
      generatedAt: new Date().toISOString(),
      editionDate: edition.edition_date,
      fallback: edition.edition_date !== today,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 500, "FEED_ERROR", "读取推荐失败", true);
  }
});
