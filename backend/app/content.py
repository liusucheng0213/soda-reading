from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .content_pipeline import ContentPipeline
from .content_sources import SOURCE_POLICIES
from .content_store import (
    ArticleVariant,
    ContentDatabase,
    DailyEdition,
    DailyRecommendation,
    SourceFetchState,
    SourcePolicyRecord,
)
from .settings import Settings


def _date(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


PRIMARY_ARTICLE = {
    "id": "soda-bookstores-current",
    "title": "Why Independent Bookstores Matter Again",
    "author": "苏打阅读编辑部",
    "source": "苏打阅读编写",
    "sourceMode": "editorial_digest",
    "contentMode": "editorial_digest",
    "sourceUrl": "https://www.unesco.org/en/world-book-capital-network",
    "publishedAt": _date(0),
    "sourcePublishedAt": _date(0),
    "cefr": "B1",
    "readingMinutes": 5,
    "topic": "文化",
    "summary": "独立书店为什么重新成为社区交流与阅读的重要空间。",
    "introZh": "独立书店为什么重新成为社区交流与阅读的重要空间。",
    "qualityScore": 88,
    "peerReviewStatus": "not_applicable",
    "difficultyMetrics": {"wordCount": 111, "averageSentenceLength": 14.8},
    "recommendationReason": "演示备用文章：与你的阅读水平和文化兴趣匹配",
    "paragraphs": [
        "Independent bookstores are more than places to buy books. They are public squares in miniature—where ideas meet, neighbors bump into one another, and curiosity feels at home.",
        "Walk into one on a rainy afternoon and you might hear a teenager recommending a novel to a stranger, or a poet testing a new line at an open mic. These moments do not trend online, but they build the quiet infrastructure of a thoughtful community.",
        "After years of online shopping and short videos, readers are seeking something real: places where they can slow down, think deeply, and connect with others. Independent bookstores and community reading spaces are filling that need.",
        "Independent bookstores are becoming places where people meet, read, and grow together. The more we support these spaces, the more vibrant and wise our communities will be.",
    ],
    "sentenceTranslations": {
        "Independent bookstores are becoming places where people meet, read, and grow together.": "独立书店正在重新成为人们交流与阅读的空间。"
    },
    "sources": [
        {"label": "UNESCO World Book Capital Network", "url": "https://www.unesco.org/en/world-book-capital-network"},
        {"label": "International Publishers Association", "url": "https://internationalpublishers.org/"},
    ],
}

ALTERNATIVES = [
    {
        "id": "urban-trees-current",
        "title": "How Urban Trees Cool a City",
        "summary": "树荫和蒸腾作用如何缓解城市热岛效应。",
        "introZh": "树荫和蒸腾作用如何缓解城市热岛效应。适合刚开始读短文的读者。",
        "source": "苏打阅读编写",
        "sourceMode": "editorial_digest",
        "contentMode": "editorial_digest",
        "publishedAt": _date(1),
        "sourcePublishedAt": _date(1),
        "cefr": "A2",
        "readingMinutes": 4,
        "topic": "自然",
        "qualityScore": 87,
        "peerReviewStatus": "not_applicable",
        "recommendationReason": "正好是 A2，原文未改写",
        "paragraphs": [
            "Cities can feel much hotter than the fields around them. Streets, cars, and dark roofs hold the sun’s heat. This is called the urban heat island.",
            "Trees help in two simple ways. Their leaves make shade, so the ground stays cooler. They also release water into the air. That process is called transpiration, and it lowers the temperature around the tree.",
            "A street with many trees can feel several degrees cooler than a street with none. Parks and small gardens do the same work. They give people a place to walk, sit, and rest on hot days.",
            "Cities cannot plant trees everywhere. Some streets are narrow. Some soil is poor. But even a few trees along a road can change how a neighborhood feels. Shade is not decoration. It is a quiet kind of public care.",
        ],
    },
    {
        "id": "ocean-heat-current",
        "title": "Measuring Heat Hidden in the Ocean",
        "summary": "卫星与 Argo 浮标如何共同观测海洋热量。",
        "introZh": "卫星与 Argo 浮标如何共同观测海洋里储存的热量。句子更长，适合中高级读者。",
        "source": "苏打阅读编写",
        "sourceMode": "editorial_digest",
        "contentMode": "editorial_digest",
        "sourceUrl": "https://oceanservice.noaa.gov/facts/heat.html",
        "publishedAt": _date(2),
        "sourcePublishedAt": _date(2),
        "cefr": "B2",
        "readingMinutes": 6,
        "topic": "科技",
        "qualityScore": 84,
        "peerReviewStatus": "not_applicable",
        "recommendationReason": "正好是 B2，原文未改写",
        "paragraphs": [
            "Most of the extra heat trapped by greenhouse gases does not stay in the air. It slips into the ocean, where it is harder to notice and harder to measure. Surface temperatures tell only part of the story, because warmth can sink, drift, and hide in deeper layers for years.",
            "Scientists now combine two kinds of evidence. Satellites watch the skin of the sea from above, mapping patterns of warmth and current. Thousands of drifting Argo floats dive and rise through the water, recording temperature and salinity on the way. Together they turn a vague idea — “the ocean is warming” — into a record with depth and time.",
            "The work is slow and incomplete. Floats miss some polar waters. Satellites struggle with clouds and ice. Still, the combined picture is clear enough to matter: the ocean has absorbed the majority of recent planetary heat. That stored energy does not disappear. It shapes storms, raises sea level as water expands, and changes how fish and currents move.",
            "For a reader, the lesson is practical. Climate is not only what the weather feels like this week. It is also heat parked out of sight, measured by instruments that never make the evening news, yet decide much of what happens next.",
        ],
    },
    {
        "id": "public-libraries-current",
        "title": "The Quiet Infrastructure of Public Libraries",
        "summary": "公共图书馆如何以低声的方式支撑一个城市的学习与公共生活。",
        "introZh": "公共图书馆如何以低声的方式支撑城市的学习与公共生活。句式更密，适合高级读者。",
        "source": "苏打阅读编写",
        "sourceMode": "editorial_digest",
        "contentMode": "editorial_digest",
        "publishedAt": _date(3),
        "sourcePublishedAt": _date(3),
        "cefr": "C1",
        "readingMinutes": 7,
        "topic": "文化",
        "qualityScore": 86,
        "peerReviewStatus": "not_applicable",
        "recommendationReason": "正好是 C1，原文未改写",
        "paragraphs": [
            "A public library rarely announces itself as infrastructure, yet that is precisely what it is: a civic machine for attention, memory, and access. It stores not only books but the conditions under which a person without money, quiet, or a private desk can still think in public.",
            "The building’s apparent stillness is misleading. Catalogues, interlibrary loans, opening hours, and the unglamorous work of weeding a collection decide who meets which idea, and when. A forgotten local newspaper, once digitized, can rearrange a family’s sense of the past.",
            "Critics sometimes call libraries obsolete in an age of search. The charge misses the point. Search retrieves fragments at speed; a library still offers duration, friction, and a room in which strangers share silence without having to buy a drink.",
            "If independent bookstores are miniature public squares, libraries are their longer-breathed cousins. They do not trend. They accumulate. A city that lets them thin out is not merely losing a service. It is dismantling one of the few remaining places where complexity is allowed to sit still.",
        ],
    },
]

FALLBACK_LIBRARY = [PRIMARY_ARTICLE, *ALTERNATIVES]

LEVEL_ORDER = {"A2": 0, "B1": 1, "B2": 2, "C1": 3}


def recommendation_score(article: dict, preferences: dict, diversity: float = 1) -> float:
    preferred_level = preferences.get("level")
    exact = 1.0 if article.get("cefr") == preferred_level else 0.0
    interest = 1 if article.get("topic") in preferences.get("topics", []) else 0.25
    level_distance = abs(
        LEVEL_ORDER.get(article.get("cefr"), 1) - LEVEL_ORDER.get(preferred_level, 1)
    )
    level_match = 1.0 if exact else max(0, 0.35 - level_distance * 0.12)
    published_raw = article.get("sourcePublishedAt") or article.get("publishedAt")
    try:
        published = datetime.fromisoformat(str(published_raw).replace("Z", "+00:00"))
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        age_days = max(0, (datetime.now(timezone.utc) - published).days)
    except (TypeError, ValueError):
        age_days = 365
    freshness = max(0, 1 - age_days / 365)
    source_quality = min(1, float(article.get("qualityScore", 80)) / 100)
    return round(
        exact * 2.6
        + interest * 0.22
        + level_match * 0.18
        + freshness * 0.1
        + source_quality * 0.08
        + diversity * 0.04,
        4,
    )


def rank_fallback(articles: list[dict], preferences: dict) -> list[dict]:
    preferred_level = preferences.get("level")
    return sorted(
        articles,
        key=lambda item: (
            0 if item.get("cefr") == preferred_level else 1,
            abs(LEVEL_ORDER.get(item.get("cefr"), 1) - LEVEL_ORDER.get(preferred_level, 1)),
            0 if item.get("topic") in preferences.get("topics", []) else 1,
            -float(item.get("qualityScore", 0)),
        ),
    )


class ContentService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.database = ContentDatabase(settings)
        self.pipeline = ContentPipeline(settings, self.database)
        self.pipeline.initialize()

    def source_status(self) -> list[dict]:
        with self.database.session() as session:
            policies = list(session.scalars(select(SourcePolicyRecord).order_by(SourcePolicyRecord.name)))
            states = {
                state.source_id: state
                for state in session.scalars(select(SourceFetchState))
            }
            return [
                {
                    "id": policy.id,
                    "name": policy.name,
                    "license": policy.license,
                    "crawlAllowed": policy.crawl_allowed,
                    "fullTextAllowed": policy.full_text_allowed,
                    "attributionRequired": policy.attribution_required,
                    "commercialAllowed": policy.commercial_allowed,
                    "region": policy.region,
                    "status": policy.status,
                    "sourceTier": policy.source_tier,
                    "sourceType": policy.source_type,
                    "endpoint": policy.endpoint,
                    "topics": policy.topics,
                    "peerReviewDefault": policy.peer_review_default,
                    "freshnessClass": policy.freshness_class,
                    "health": self._health(states.get(policy.id)),
                }
                for policy in policies
            ]

    @staticmethod
    def _health(state: SourceFetchState | None) -> dict:
        if not state:
            return {
                "score": 1,
                "status": "not_run",
                "lastSuccessAt": None,
                "lastError": "",
                "fetchedCount": 0,
                "acceptedCount": 0,
                "duplicateCount": 0,
            }
        return {
            "score": state.health_score,
            "status": "healthy" if state.consecutive_failures == 0 else "degraded",
            "lastSuccessAt": state.last_success_at.isoformat() if state.last_success_at else None,
            "lastError": state.last_error,
            "fetchedCount": state.fetched_count,
            "acceptedCount": state.accepted_count,
            "duplicateCount": state.duplicate_count,
        }

    def daily_feed(self, preferences: dict, user_id: str) -> dict:
        local_date = datetime.now(ZoneInfo(self.settings.content_timezone)).date()
        preference_hash = hashlib.sha256(
            json.dumps(preferences, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        with self.database.session() as session:
            edition = session.scalar(
                select(DailyEdition)
                .where(
                    DailyEdition.status == "published",
                    DailyEdition.edition_date <= local_date,
                    DailyEdition.edition_date >= local_date - timedelta(days=7),
                )
                .order_by(DailyEdition.edition_date.desc())
                .limit(1)
            )
            if not edition or not edition.article_ids:
                return self._fallback(preferences)
            existing = session.scalar(
                select(DailyRecommendation).where(
                    DailyRecommendation.user_id == user_id,
                    DailyRecommendation.recommendation_date == local_date,
                )
            )
            if (
                existing
                and existing.reasons.get("preferenceHash") == preference_hash
                and existing.reasons.get("editionKey") == ",".join(edition.article_ids or [])
            ):
                article_ids = [existing.primary_article_id, *existing.alternative_article_ids]
                stored = list(session.scalars(
                    select(ArticleVariant).where(ArticleVariant.id.in_(article_ids))
                ))
                by_id = {article.id: article for article in stored}
                if all(article_id in by_id for article_id in article_ids):
                    primary = self._article_dict(by_id[article_ids[0]], existing.scores.get(article_ids[0], 0))
                    alternatives = [
                        self._article_dict(by_id[article_id], existing.scores.get(article_id, 0))
                        for article_id in article_ids[1:]
                    ]
                    return {
                        "primary": primary,
                        "alternatives": alternatives,
                        "generatedAt": existing.created_at.isoformat(),
                        "editionDate": edition.edition_date.isoformat(),
                    }

            articles = list(session.scalars(
                select(ArticleVariant).where(ArticleVariant.id.in_(edition.article_ids))
            ))
            if len(articles) < 3:
                return self._fallback(preferences)
            recent_recommendations = list(session.scalars(
                select(DailyRecommendation).where(
                    DailyRecommendation.user_id == user_id,
                    DailyRecommendation.recommendation_date < local_date,
                    DailyRecommendation.recommendation_date >= local_date - timedelta(days=7),
                )
            ))
            recent_ids = {
                article_id
                for recommendation in recent_recommendations
                for article_id in [
                    recommendation.primary_article_id,
                    *recommendation.alternative_article_ids,
                ]
            }

            def rank_key(article: ArticleVariant) -> tuple[int, float]:
                base = recommendation_score(
                    {
                        "topic": article.topic,
                        "cefr": article.cefr,
                        "sourcePublishedAt": article.source_published_at.isoformat(),
                        "qualityScore": article.quality_score,
                    },
                    preferences,
                )
                daily_tie_break = int(hashlib.sha256(
                    f"{user_id}:{local_date}:{article.id}".encode()
                ).hexdigest()[:6], 16) / 0xFFFFFF / 100
                return (1 if article.id not in recent_ids else 0, base + daily_tie_break)

            ranked = sorted(
                articles,
                key=rank_key,
                reverse=True,
            )
            exact_level = [article for article in ranked if article.cefr == preferences.get("level")]
            if not exact_level:
                return self._fallback(preferences)
            primary = exact_level[0]
            alternatives = []
            used_topics = {primary.topic}
            for article in ranked:
                if article.id == primary.id:
                    continue
                if len(alternatives) >= 6:
                    break
                alternatives.append(article)
                used_topics.add(article.topic)
            selected = [primary, *alternatives]
            scores = {
                article.id: recommendation_score(
                    {
                        "topic": article.topic,
                        "cefr": article.cefr,
                        "sourcePublishedAt": article.source_published_at.isoformat(),
                        "qualityScore": article.quality_score,
                    },
                    preferences,
                    diversity=1 if article.topic not in used_topics else 0.7,
                )
                for article in selected
            }
            reasons = {
                "preferenceHash": preference_hash,
                "editionKey": ",".join(edition.article_ids or []),
                "primary": f"匹配你的 {preferences.get('level')} 水平与“{primary.topic}”兴趣",
            }
            if existing:
                session.delete(existing)
                session.flush()
            session.add(DailyRecommendation(
                user_id=user_id,
                recommendation_date=local_date,
                primary_article_id=primary.id,
                alternative_article_ids=[article.id for article in alternatives],
                reasons=reasons,
                scores=scores,
            ))
            return {
                "primary": self._article_dict(primary, scores[primary.id], reasons["primary"]),
                "alternatives": [self._article_dict(article, scores[article.id]) for article in alternatives],
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "editionDate": edition.edition_date.isoformat(),
            }

    @staticmethod
    def _article_dict(article: ArticleVariant, score: float, reason: str = "最近7天的高质量匹配文章") -> dict:
        sources = article.sources or []
        return {
            "id": article.id,
            "title": article.title,
            "author": article.author,
            "source": sources[0]["label"] if article.content_mode != "editorial_digest" and sources else "苏打阅读编写",
            "sourceMode": article.content_mode,
            "contentMode": article.content_mode,
            "sourceUrl": sources[0]["url"] if sources else "",
            "publishedAt": (article.published_at or article.created_at).isoformat(),
            "sourcePublishedAt": article.source_published_at.isoformat(),
            "cefr": article.cefr,
            "readingMinutes": article.reading_minutes,
            "topic": article.topic,
            "summary": article.summary,
            "introZh": article.intro_zh or article.summary,
            "paragraphs": article.paragraphs,
            "sentenceTranslations": article.sentence_translations,
            "glossary": article.glossary,
            "sources": sources,
            "peerReviewStatus": article.peer_review_status,
            "qualityScore": article.quality_score,
            "difficultyMetrics": article.difficulty_metrics,
            "recommendationScore": score,
            "recommendationReason": reason,
        }

    @staticmethod
    def _fallback(preferences: dict) -> dict:
        ranked = rank_fallback(FALLBACK_LIBRARY, preferences)
        primary, *alternatives = ranked
        preferred_level = preferences.get("level")
        reason = (
            f"正好是 {preferred_level}，原文未改写"
            if primary.get("cefr") == preferred_level
            else f"你选的是 {preferred_level}，这篇最接近的是 {primary.get('cefr')}。原文未改写。"
        )
        return {
            "primary": {
                **primary,
                "recommendationScore": recommendation_score(primary, preferences),
                "recommendationReason": reason,
            },
            "alternatives": [
                {
                    **item,
                    "recommendationScore": recommendation_score(item, preferences),
                    "recommendationReason": (
                        f"正好是 {preferred_level}，原文未改写"
                        if item.get("cefr") == preferred_level
                        else f"邻近难度 {item.get('cefr')}"
                    ),
                }
                for item in alternatives[:4]
            ],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "editionDate": None,
            "fallback": True,
        }
