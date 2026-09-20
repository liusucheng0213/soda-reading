from __future__ import annotations

import asyncio
import hashlib
import html
import json
import math
import random
import re
import urllib.robotparser
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from langid.langid import LanguageIdentifier, model as langid_model
from sqlalchemy import select

from .content_store import ContentDatabase, SourceFetchState
from .schemas import SourcePolicy
from .settings import Settings
from .text_excerpt import (
    is_low_quality_source,
    paragraphs_from_article_html,
    paragraphs_from_cjk_text,
    paragraphs_from_html,
    paragraphs_from_plain_text,
    select_reading_excerpt,
)


TOPICS = ["科技", "文化", "商业", "自然", "健康", "历史"]
LANGUAGE_IDENTIFIER = LanguageIdentifier.from_modelstring(langid_model, norm_probs=True)
TOPIC_KEYWORDS = {
    "科技": {
        "technology", "software", "computer", "robot", "artificial intelligence", "ai", "energy",
        "engineering", "satellite", "spacecraft", "quantum", "internet", "data",
    },
    "文化": {
        "culture", "book", "literature", "language", "museum", "art", "music", "education",
        "community", "library", "reading", "society", "novel", "fiction", "story",
    },
    "商业": {
        "business", "economy", "economic", "finance", "financial", "market", "trade", "company",
        "employment", "development", "industry", "bank", "inflation", "interest rate", "federal reserve",
        "investment", "monetary",
    },
    "自然": {
        "climate", "ocean", "forest", "species", "animal", "biodiversity", "earth", "environment",
        "weather", "water", "ecosystem", "conservation",
    },
    "健康": {
        "health", "medical", "medicine", "patient", "disease", "treatment", "nutrition", "brain",
        "mental", "hospital", "clinical", "vaccine",
    },
    "历史": {
        "history", "historical", "archive", "ancient", "heritage", "century", "archaeology",
        "collection", "war", "civilization",
    },
}


SOURCE_POLICIES = [
    SourcePolicy(
        id="soda-editorial",
        name="苏打阅读原创导读",
        license="原创",
        crawlAllowed=False,
        fullTextAllowed=True,
        commercialAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="editorial",
        topics=TOPICS,
        peerReviewDefault="not_applicable",
        freshnessClass="evergreen",
    ),
    SourcePolicy(
        id="crossref-api",
        name="Crossref Works API",
        license="元数据索引；原文许可逐项核验",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://api.crossref.org/works",
        topics=["科技", "自然", "健康", "文化", "商业", "历史"],
        peerReviewDefault="peer_reviewed",
        freshnessClass="paper",
    ),
    SourcePolicy(
        id="openalex-api",
        name="OpenAlex Works API",
        license="CC0 元数据；原文许可逐项核验",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://api.openalex.org/works",
        topics=["科技", "自然", "健康", "文化", "商业", "历史"],
        peerReviewDefault="unknown",
        freshnessClass="paper",
    ),
    SourcePolicy(
        id="europe-pmc-api",
        name="Europe PMC REST API",
        license="元数据与摘要索引；开放全文许可逐项核验",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://www.ebi.ac.uk/europepmc/webservices/rest/search",
        topics=["健康", "自然", "科技"],
        peerReviewDefault="peer_reviewed",
        freshnessClass="paper",
    ),
    SourcePolicy(
        id="arxiv-api",
        name="arXiv API",
        license="元数据与摘要索引；每篇论文许可不同",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="C",
        sourceType="api",
        endpoint="https://export.arxiv.org/api/query",
        topics=["科技", "自然", "商业"],
        peerReviewDefault="preprint",
        freshnessClass="paper",
    ),
    SourcePolicy(
        id="plos-api",
        name="PLOS Search API",
        license="论文元数据索引；正文许可逐项记录",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://api.plos.org/search",
        topics=["健康", "自然", "科技"],
        peerReviewDefault="peer_reviewed",
        freshnessClass="paper",
    ),
    SourcePolicy(
        id="doaj-api",
        name="DOAJ Articles API",
        license="开放元数据；文章正文许可逐项核验",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://doaj.org/api/search/articles",
        topics=["科技", "自然", "健康", "文化", "商业", "历史"],
        peerReviewDefault="peer_reviewed",
        freshnessClass="paper",
    ),
    SourcePolicy(
        id="nasa-rss",
        name="NASA News",
        license="美国政府作品；第三方材料剔除后可保存正文",
        crawlAllowed=True,
        fullTextAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://www.nasa.gov/news-release/feed/",
        topics=["科技", "自然"],
        peerReviewDefault="not_applicable",
        freshnessClass="news",
    ),
    SourcePolicy(
        id="noaa-rss",
        name="NOAA National Ocean Service News",
        license="美国政府作品；第三方材料剔除后可保存正文",
        crawlAllowed=True,
        fullTextAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://oceanservice.noaa.gov/newsroom/nosmedia.xml",
        topics=["自然", "科技"],
        peerReviewDefault="not_applicable",
        freshnessClass="news",
    ),
    SourcePolicy(
        id="usgs-rss",
        name="USGS National News Releases",
        license="美国政府作品；第三方材料剔除后可保存正文",
        crawlAllowed=True,
        fullTextAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://www.usgs.gov/news/national-news-release/feed",
        topics=["自然", "科技", "历史"],
        peerReviewDefault="not_applicable",
        freshnessClass="news",
    ),
    SourcePolicy(
        id="nih-rss",
        name="NIH/NLM PubMed News",
        license="NIH/NLM 政府来源；仅索引与事实提取",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://www.nlm.nih.gov/rss/auto/PubMedNews.rss",
        topics=["健康", "科技"],
        peerReviewDefault="not_applicable",
        freshnessClass="news",
    ),
    SourcePolicy(
        id="cdc-eid-rss",
        name="CDC Emerging Infectious Diseases · Ahead of Print",
        license="CDC 政府与同行评审来源；仅保存元数据和摘要，第三方材料逐项核验",
        crawlAllowed=True,
        fullTextAllowed=False,
        commercialAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://wwwnc.cdc.gov/eid/rss/ahead-of-print.xml",
        topics=["健康", "自然"],
        peerReviewDefault="peer_reviewed",
        freshnessClass="paper",
    ),
    SourcePolicy(
        id="loc-rss",
        name="Library of Congress Blogs",
        license="政府来源；馆藏版权逐项核验",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://blogs.loc.gov/loc/feed/",
        topics=["历史", "文化"],
        peerReviewDefault="not_applicable",
        freshnessClass="evergreen",
    ),
    SourcePolicy(
        id="smithsonian-history-rss",
        name="Smithsonian Magazine History",
        license="专业编辑来源；仅索引与原创事实摘要",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="B",
        sourceType="rss",
        endpoint="https://www.smithsonianmag.com/rss/history/",
        topics=["历史", "文化"],
        peerReviewDefault="not_applicable",
        freshnessClass="evergreen",
    ),
    SourcePolicy(
        id="worldbank-api",
        name="World Bank Documents & Reports API",
        license="官方公开元数据；正文许可逐项核验",
        crawlAllowed=True,
        fullTextAllowed=False,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://search.worldbank.org/api/v3/wds",
        topics=["商业", "科技", "文化"],
        peerReviewDefault="unknown",
        freshnessClass="evergreen",
    ),
    SourcePolicy(
        id="federal-reserve-rss",
        name="Federal Reserve Press Releases",
        license="美国政府作品，可保存官方新闻稿正文",
        crawlAllowed=True,
        fullTextAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://www.federalreserve.gov/feeds/press_all.xml",
        topics=["商业"],
        peerReviewDefault="not_applicable",
        freshnessClass="news",
    ),
    SourcePolicy(
        id="the-conversation-atom",
        name="The Conversation",
        license="CC BY-ND 4.0；保留署名、不改编，可展示原文",
        crawlAllowed=True,
        fullTextAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="rss",
        endpoint="https://theconversation.com/articles.atom",
        topics=["科技", "自然", "健康", "商业", "文化"],
        peerReviewDefault="not_applicable",
        freshnessClass="news",
    ),
    SourcePolicy(
        id="wikipedia-featured",
        name="Wikipedia Featured and Most Read",
        license="CC BY-SA 4.0；保存节选并署名",
        crawlAllowed=True,
        fullTextAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://en.wikipedia.org/api/rest_v1/feed/featured",
        topics=["科技", "自然", "健康", "文化", "历史", "商业"],
        peerReviewDefault="not_applicable",
        freshnessClass="evergreen",
    ),
    SourcePolicy(
        id="zhwiki-featured",
        name="中文维基百科精选 · 译成控难英语",
        license="CC BY-SA 4.0；中文原文可译，英文为教学译本并署名",
        crawlAllowed=True,
        fullTextAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://zh.wikipedia.org/api/rest_v1/feed/featured",
        topics=["文化", "历史", "科技", "自然"],
        peerReviewDefault="not_applicable",
        freshnessClass="evergreen",
    ),
    SourcePolicy(
        id="gutenberg-popular",
        name="Project Gutenberg Popular Public-Domain Books",
        license="公有领域；保存热门小说章节节选",
        crawlAllowed=True,
        fullTextAllowed=True,
        commercialAllowed=True,
        status="active",
        sourceTier="A",
        sourceType="api",
        endpoint="https://gutendex.com/books",
        topics=["文化"],
        peerReviewDefault="not_applicable",
        freshnessClass="literature",
    ),
]


@dataclass
class RawCandidate:
    source_id: str
    external_id: str
    title: str
    url: str
    published_at: datetime
    summary: str = ""
    authors: list[str] = field(default_factory=list)
    doi: str = ""
    topic: str = ""
    content_kind: str = "news"
    peer_review_status: str = "unknown"
    license: str = ""
    full_text_allowed: bool = False
    source_tier: str = "B"
    metadata: dict[str, Any] = field(default_factory=dict)


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_date(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value).strip()
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            try:
                parsed = parsedate_to_datetime(raw)
            except (TypeError, ValueError):
                try:
                    parsed = datetime.strptime(raw[:10], "%Y-%m-%d")
                except ValueError:
                    return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def topic_for(title: str, summary: str, fallback: list[str]) -> str:
    haystack = f"{title} {summary}".lower()
    scores = {
        topic: sum(2 if " " in keyword and keyword in haystack else len(re.findall(rf"\b{re.escape(keyword)}\b", haystack))
                   for keyword in keywords)
        for topic, keywords in TOPIC_KEYWORDS.items()
    }
    best = max(scores, key=scores.get)
    return best if scores[best] else (fallback[0] if fallback else "科技")


class RespectfulHttpClient:
    def __init__(self, settings: Settings, database: ContentDatabase):
        self.settings = settings
        self.database = database
        self.semaphores: dict[str, asyncio.Semaphore] = {}
        self.robot_parsers: dict[str, urllib.robotparser.RobotFileParser] = {}

    def _semaphore(self, url: str) -> asyncio.Semaphore:
        domain = urlparse(url).netloc
        return self.semaphores.setdefault(domain, asyncio.Semaphore(self.settings.content_per_domain_concurrency))

    async def robots_allowed(self, url: str) -> bool:
        parsed = urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        parser = self.robot_parsers.get(origin)
        if parser is None:
            parser = urllib.robotparser.RobotFileParser(f"{origin}/robots.txt")
            try:
                async with httpx.AsyncClient(timeout=5, follow_redirects=True) as client:
                    response = await client.get(parser.url, headers={"User-Agent": self.settings.content_user_agent})
                parser.parse(response.text.splitlines() if response.status_code == 200 else [])
            except httpx.HTTPError:
                parser.parse([])
            self.robot_parsers[origin] = parser
        return parser.can_fetch(self.settings.content_user_agent, url)

    async def get(
        self,
        source: SourcePolicy,
        params: dict | None = None,
        url: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response | None:
        request_url = url or source.endpoint
        headers = {
            "User-Agent": self.settings.content_user_agent,
            "Api-User-Agent": self.settings.content_user_agent,
            "Accept-Encoding": "gzip, deflate",
            "Accept": "application/json, application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, text/plain;q=0.8",
        }
        if extra_headers:
            headers.update(extra_headers)
        if self.settings.content_contact_email:
            headers["From"] = self.settings.content_contact_email
        with self.database.session() as session:
            state = session.get(SourceFetchState, source.id)
            # A single source can have many paginated API URLs, so its one source-level
            # ETag must never be reused across pages. Conditional requests remain enabled
            # for stable RSS/Sitemap/HTML endpoints.
            if state and source.sourceType != "api" and request_url == source.endpoint:
                if state.etag:
                    headers["If-None-Match"] = state.etag
                if state.last_modified:
                    headers["If-Modified-Since"] = state.last_modified

        if source.sourceType in {"sitemap", "html"} and not await self.robots_allowed(request_url):
            raise PermissionError(f"robots.txt disallows {request_url}")

        async with self._semaphore(request_url):
            for attempt in range(3):
                try:
                    async with httpx.AsyncClient(
                        timeout=self.settings.content_source_timeout_seconds,
                        follow_redirects=True,
                    ) as client:
                        response = await client.get(request_url, params=params, headers=headers)
                    if response.status_code == 304:
                        self._record_success(source.id, response, 0)
                        return None
                    if response.status_code == 429:
                        delay = min(float(response.headers.get("Retry-After", 2 ** attempt)), 15)
                        await asyncio.sleep(delay + random.random())
                        continue
                    if response.status_code >= 500:
                        if attempt == 2:
                            response.raise_for_status()
                        await asyncio.sleep((2 ** attempt) + random.random())
                        continue
                    if response.status_code in {401, 403, 404}:
                        response.raise_for_status()
                    response.raise_for_status()
                    self._record_success(source.id, response, 0)
                    return response
                except (httpx.HTTPError, ValueError) as error:
                    status = getattr(getattr(error, "response", None), "status_code", None)
                    if attempt == 2 or status in {401, 403, 404}:
                        self._record_failure(source.id, error)
                        raise
                    await asyncio.sleep((2 ** attempt) + random.random())
        return None

    def _record_success(self, source_id: str, response: httpx.Response, count: int) -> None:
        with self.database.session() as session:
            state = session.get(SourceFetchState, source_id) or SourceFetchState(source_id=source_id)
            state.etag = response.headers.get("ETag", state.etag or "")
            state.last_modified = response.headers.get("Last-Modified", state.last_modified or "")
            state.last_success_at = datetime.now(timezone.utc)
            state.last_error = ""
            state.consecutive_failures = 0
            state.fetched_count = (state.fetched_count or 0) + count
            state.health_score = min(1.0, (state.health_score or 1.0) + 0.05)
            session.add(state)

    def clear_conditional(self, source_id: str) -> None:
        with self.database.session() as session:
            state = session.get(SourceFetchState, source_id)
            if not state:
                return
            state.etag = ""
            state.last_modified = ""
            session.add(state)

    def record_count(
        self,
        source_id: str,
        fetched: int,
        accepted: int = 0,
        duplicates: int = 0,
        evaluated: bool = False,
    ) -> None:
        with self.database.session() as session:
            state = session.get(SourceFetchState, source_id) or SourceFetchState(source_id=source_id)
            state.fetched_count = (state.fetched_count or 0) + fetched
            state.accepted_count = (state.accepted_count or 0) + accepted
            state.duplicate_count = (state.duplicate_count or 0) + duplicates
            if evaluated and state.fetched_count >= 50:
                valid_rate = state.accepted_count / max(1, state.fetched_count)
                duplicate_rate = state.duplicate_count / max(1, state.fetched_count)
                adjustment = -0.1 if valid_rate < 0.05 or duplicate_rate > 0.7 else 0.02
                state.health_score = min(1.0, max(0.1, (state.health_score or 1.0) + adjustment))
            session.add(state)

    def _record_failure(self, source_id: str, error: Exception) -> None:
        with self.database.session() as session:
            state = session.get(SourceFetchState, source_id) or SourceFetchState(source_id=source_id)
            state.last_error = f"{type(error).__name__}: {str(error)[:300]}"
            state.consecutive_failures = (state.consecutive_failures or 0) + 1
            state.health_score = max(0.1, (state.health_score or 1.0) - 0.15)
            session.add(state)


class SourceAdapter:
    def __init__(self, policy: SourcePolicy, client: RespectfulHttpClient):
        self.policy = policy
        self.client = client

    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        raise NotImplementedError

    def candidate(self, **values: Any) -> RawCandidate:
        title = clean_text(values.get("title"))
        summary = clean_text(values.get("summary"))
        return RawCandidate(
            source_id=self.policy.id,
            external_id=clean_text(values.get("external_id")) or hashlib.sha256(
                f"{title}|{values.get('url', '')}".encode()
            ).hexdigest(),
            title=title,
            url=str(values.get("url", "")),
            published_at=values["published_at"],
            # Discovery stores a bounded abstract/summary, never an unlicensed article body.
            summary=summary[:3000],
            authors=[clean_text(author) for author in values.get("authors", []) if clean_text(author)],
            doi=clean_text(values.get("doi")).lower().removeprefix("https://doi.org/"),
            topic=topic_for(title, summary, self.policy.topics),
            content_kind=self.policy.freshnessClass,
            peer_review_status=values.get("peer_review_status", self.policy.peerReviewDefault),
            license=values.get("license", self.policy.license),
            full_text_allowed=bool(values.get("full_text_allowed", self.policy.fullTextAllowed)),
            source_tier=self.policy.sourceTier,
            metadata=values.get("metadata", {}),
        )


class CrossrefAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=90)
        params = {
            "filter": f"from-pub-date:{start.isoformat()},until-pub-date:{end.isoformat()},type:journal-article",
            "sort": "published",
            "order": "desc",
            "rows": min(limit, 200),
            "offset": max(0, offset),
            "select": "DOI,title,author,published,URL,abstract,subject,publisher,type",
        }
        response = await self.client.get(self.policy, params)
        if response is None:
            return []
        items = response.json().get("message", {}).get("items", [])
        results = []
        for item in items:
            parts = item.get("published", {}).get("date-parts", [[]])[0]
            if not parts:
                continue
            published = datetime(parts[0], parts[1] if len(parts) > 1 else 1, parts[2] if len(parts) > 2 else 1, tzinfo=timezone.utc)
            authors = [
                " ".join(filter(None, [author.get("given"), author.get("family")]))
                for author in item.get("author", [])
            ]
            results.append(self.candidate(
                external_id=item.get("DOI", ""),
                doi=item.get("DOI", ""),
                title=(item.get("title") or [""])[0],
                url=item.get("URL", ""),
                published_at=published,
                summary=item.get("abstract", ""),
                authors=authors,
                metadata={"publisher": item.get("publisher"), "subjects": item.get("subject", [])},
            ))
        return results


class OpenAlexAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=90)
        params = {
            "filter": f"from_publication_date:{start.isoformat()},to_publication_date:{end.isoformat()},language:en",
            "sort": "publication_date:desc",
            "per-page": min(limit, 200),
            "page": max(1, offset // max(1, min(limit, 200)) + 1),
        }
        if self.client.settings.content_contact_email:
            params["mailto"] = self.client.settings.content_contact_email
        response = await self.client.get(self.policy, params)
        if response is None:
            return []
        results = []
        for item in response.json().get("results", []):
            published = parse_date(item.get("publication_date"))
            if not published:
                continue
            abstract_index = item.get("abstract_inverted_index") or {}
            ordered = sorted(
                ((position, word) for word, positions in abstract_index.items() for position in positions),
                key=lambda pair: pair[0],
            )
            abstract = " ".join(word for _, word in ordered)
            primary_location = item.get("primary_location") or {}
            results.append(self.candidate(
                external_id=item.get("id", ""),
                doi=item.get("doi", ""),
                title=item.get("display_name", ""),
                url=item.get("doi") or primary_location.get("landing_page_url") or item.get("id", ""),
                published_at=published,
                summary=abstract,
                authors=[
                    authorship.get("author", {}).get("display_name", "")
                    for authorship in item.get("authorships", [])
                ],
                peer_review_status="peer_reviewed" if item.get("type") == "article" else "unknown",
                metadata={"openAccess": item.get("open_access", {}), "type": item.get("type")},
            ))
        return results


class EuropePmcAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=90)
        params = {
            "query": f"FIRST_PDATE:[{start.isoformat()} TO {end.isoformat()}] AND LANG:eng",
            "format": "json",
            "pageSize": min(limit, 200),
            "page": max(1, offset // max(1, min(limit, 200)) + 1),
            "sort": "FIRST_PDATE_D desc",
        }
        response = await self.client.get(self.policy, params)
        if response is None:
            return []
        results = []
        for item in response.json().get("resultList", {}).get("result", []):
            published = parse_date(item.get("firstPublicationDate") or item.get("firstIndexDate"))
            if not published:
                continue
            identifier = item.get("doi") or item.get("pmcid") or item.get("pmid")
            results.append(self.candidate(
                external_id=identifier,
                doi=item.get("doi", ""),
                title=item.get("title", ""),
                url=f"https://europepmc.org/article/{item.get('source', 'MED')}/{item.get('id', identifier)}",
                published_at=published,
                summary=item.get("abstractText", ""),
                authors=[item.get("authorString", "")],
                metadata={"journal": item.get("journalTitle"), "citedByCount": item.get("citedByCount")},
            ))
        return results


class ArxivAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        params = {
            "search_query": "cat:cs.* OR cat:physics.* OR cat:q-bio.* OR cat:econ.*",
            "start": max(0, offset),
            "max_results": min(limit, 100),
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        }
        response = await self.client.get(self.policy, params)
        if response is None:
            return []
        root = ET.fromstring(response.content)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        results = []
        for entry in root.findall("atom:entry", ns):
            published = parse_date(entry.findtext("atom:published", default="", namespaces=ns))
            if not published:
                continue
            url = entry.findtext("atom:id", default="", namespaces=ns)
            results.append(self.candidate(
                external_id=url.rstrip("/").split("/")[-1],
                title=entry.findtext("atom:title", default="", namespaces=ns),
                url=url,
                published_at=published,
                summary=entry.findtext("atom:summary", default="", namespaces=ns),
                authors=[
                    author.findtext("atom:name", default="", namespaces=ns)
                    for author in entry.findall("atom:author", ns)
                ],
                peer_review_status="preprint",
                metadata={"updatedAt": entry.findtext("atom:updated", default="", namespaces=ns)},
            ))
        return results


class PlosAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        start = (datetime.now(timezone.utc).date() - timedelta(days=90)).isoformat()
        params = {
            "q": f"publication_date:[{start}T00:00:00Z TO NOW]",
            "fl": "id,title,abstract,publication_date,author_display,journal,subject",
            "sort": "publication_date desc",
            "rows": min(limit, 100),
            "start": max(0, offset),
            "wt": "json",
        }
        response = await self.client.get(self.policy, params)
        if response is None:
            return []
        results = []
        for item in response.json().get("response", {}).get("docs", []):
            published = parse_date(item.get("publication_date"))
            if not published:
                continue
            identifier = item.get("id", "")
            abstract = item.get("abstract") or ""
            if isinstance(abstract, list):
                abstract = " ".join(abstract)
            results.append(self.candidate(
                external_id=identifier,
                doi=identifier,
                title=item.get("title", ""),
                url=f"https://doi.org/{identifier}",
                published_at=published,
                summary=abstract,
                authors=item.get("author_display", []),
                license="PLOS open-access article; exact license stored per item",
                metadata={"journal": item.get("journal"), "subjects": item.get("subject", [])},
            ))
        return results


class DoajAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        page_size = min(limit, 100)
        page = max(1, offset // max(1, page_size) + 1)
        year = datetime.now(timezone.utc).year
        response = await self.client.get(
            self.policy,
            {"page": page, "pageSize": page_size},
            url=f"{self.policy.endpoint}/bibjson.year:{year}",
        )
        if response is None:
            return []
        results = []
        for item in response.json().get("results", []):
            bib = item.get("bibjson") or {}
            try:
                month = int(bib.get("month") or 1)
                published = datetime(
                    int(bib.get("year") or year),
                    max(1, min(month, 12)),
                    1,
                    tzinfo=timezone.utc,
                )
            except (TypeError, ValueError):
                continue
            identifiers = bib.get("identifier") or []
            doi = next(
                (entry.get("id", "") for entry in identifiers if entry.get("type") == "doi"),
                "",
            )
            links = bib.get("link") or []
            landing_url = next((entry.get("url", "") for entry in links if entry.get("url")), "")
            results.append(self.candidate(
                external_id=item.get("id", "") or doi,
                doi=doi,
                title=bib.get("title", ""),
                url=landing_url or (f"https://doi.org/{doi}" if doi else ""),
                published_at=published,
                summary=bib.get("abstract", ""),
                authors=[entry.get("name", "") for entry in bib.get("author", [])],
                license="DOAJ open-access index; exact article license requires item review",
                metadata={
                    "journal": (bib.get("journal") or {}).get("title"),
                    "subjects": [entry.get("term") for entry in bib.get("subject", [])],
                    "indexedAt": item.get("created_date"),
                },
            ))
        return results


class WorldBankAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        params = {
            "format": "json",
            "rows": min(limit, 200),
            "os": max(0, offset),
            "fl": "docdt,abstracts,authr,docty,lang,pdfurl",
            "strdate": (datetime.now(timezone.utc).date() - timedelta(days=365)).isoformat(),
            "docty_exact": "Policy Research Working Paper",
            "sort": "docdt",
            "order": "desc",
        }
        response = await self.client.get(self.policy, params)
        if response is None:
            return []
        documents = response.json().get("documents") or {}
        results = []
        for key, item in documents.items():
            if key == "facets" or not isinstance(item, dict):
                continue
            published = parse_date(item.get("docdt"))
            if not published:
                continue
            author_data = item.get("authors") or {}
            authors = [
                entry.get("author", "")
                for entry in author_data.values()
                if isinstance(entry, dict)
            ] if isinstance(author_data, dict) else []
            results.append(self.candidate(
                external_id=item.get("id") or item.get("guid") or key,
                title=item.get("display_title") or item.get("docna") or item.get("repnme"),
                url=item.get("url") or item.get("pdfurl"),
                published_at=published,
                summary=item.get("abstracts", ""),
                authors=authors,
                peer_review_status="institutional_report",
                metadata={"documentType": item.get("docty"), "pdfUrl": item.get("pdfurl")},
            ))
        return results


class RssAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        response = await self.client.get(self.policy)
        if response is None and self.policy.fullTextAllowed:
            self.client.clear_conditional(self.policy.id)
            response = await self.client.get(self.policy)
        if response is None:
            return []
        try:
            root = ET.fromstring(response.content)
        except ET.ParseError:
            return []
        items = root.findall(".//item")
        if not items:
            ns = {"atom": "http://www.w3.org/2005/Atom"}
            items = root.findall(".//{http://www.w3.org/2005/Atom}entry") or root.findall(".//atom:entry", ns)
        results = []
        pending_pages: list[dict[str, Any]] = []
        for item in items[offset:offset + max(limit, 8)]:
            title = self._text(item, ["title", "{http://www.w3.org/2005/Atom}title"])
            url = self._text(item, ["link", "{http://www.w3.org/2005/Atom}id"])
            if not url:
                link_node = item.find("{http://www.w3.org/2005/Atom}link") or item.find("link")
                url = (link_node.attrib.get("href", "") if link_node is not None else "") or (link_node.text or "" if link_node is not None else "")
            if is_low_quality_source(title, url):
                continue
            published = parse_date(self._text(item, [
                "pubDate",
                "{http://purl.org/dc/elements/1.1/}date",
                "{http://www.w3.org/2005/Atom}published",
                "{http://www.w3.org/2005/Atom}updated",
            ]))
            if not title or not url or not published:
                continue
            summary = self._text(item, [
                "description",
                "{http://www.w3.org/2005/Atom}summary",
                "{http://purl.org/rss/1.0/modules/content/}encoded",
                "{http://www.w3.org/2005/Atom}content",
            ])
            encoded = self._markup(item, [
                "{http://purl.org/rss/1.0/modules/content/}encoded",
                "{http://www.w3.org/2005/Atom}content",
                "description",
            ])
            paragraphs = select_reading_excerpt(paragraphs_from_html(encoded)) if self.policy.fullTextAllowed else []
            authors = [self._text(item, [
                "author",
                "{http://purl.org/dc/elements/1.1/}creator",
                "{http://www.w3.org/2005/Atom}author",
            ])]
            external_id = self._text(item, ["guid", "{http://www.w3.org/2005/Atom}id"]) or url
            if self.policy.fullTextAllowed and len(paragraphs) < 3:
                pending_pages.append({
                    "title": title,
                    "url": url,
                    "published": published,
                    "summary": summary,
                    "authors": authors,
                    "external_id": external_id,
                })
                continue
            results.append(self.candidate(
                external_id=external_id,
                title=title,
                url=url,
                published_at=published,
                summary=summary or " ".join(paragraphs)[:1800],
                authors=authors,
                metadata={"paragraphs": paragraphs} if paragraphs else {},
            ))
        if self.policy.fullTextAllowed and pending_pages:
            cap = 3 if limit < 20 else 8
            enriched = await asyncio.gather(
                *(self._excerpt_page(item) for item in pending_pages[:cap]),
                return_exceptions=True,
            )
            for item in enriched:
                if isinstance(item, Exception) or item is None:
                    continue
                results.append(item)
        if self.policy.fullTextAllowed and not results:
            self.client.clear_conditional(self.policy.id)
        return results

    async def _excerpt_page(self, item: dict[str, Any]) -> RawCandidate | None:
        paragraphs = await self._paragraphs_from_page(item["url"])
        if len(paragraphs) < 3:
            return None
        return self.candidate(
            external_id=item["external_id"],
            title=item["title"],
            url=item["url"],
            published_at=item["published"],
            summary=item["summary"] or " ".join(paragraphs)[:1800],
            authors=item["authors"],
            metadata={"paragraphs": paragraphs, "excerptSource": "article-page"},
        )

    async def _paragraphs_from_page(self, url: str) -> list[str]:
        try:
            if not await self.client.robots_allowed(url):
                return []
            response = await self.client.get(self.policy, url=url)
        except Exception:
            return []
        if response is None:
            return []
        return select_reading_excerpt(paragraphs_from_article_html(response.text))

    @staticmethod
    def _text(node: ET.Element, paths: list[str]) -> str:
        for path in paths:
            found = node.find(path)
            if found is None:
                continue
            text = clean_text("".join(found.itertext()))
            if text:
                return text
        return ""

    @staticmethod
    def _markup(node: ET.Element, paths: list[str]) -> str:
        for path in paths:
            found = node.find(path)
            if found is None:
                continue
            if not list(found):
                text = found.text or ""
                if text.strip():
                    return text
                continue
            parts = [found.text or ""]
            for child in list(found):
                parts.append(ET.tostring(child, encoding="unicode"))
                parts.append(child.tail or "")
            markup = "".join(parts)
            if markup.strip():
                return markup
        return ""


class CdcEidAdapter(RssAdapter):
    """Enrich CDC's discovery RSS with the article's bounded abstract.

    The feed intentionally contains only titles and author names. Fetching the
    official article page lets the pipeline retain a useful abstract without
    copying the article body.
    """

    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        candidates = await super().fetch(limit, offset)

        async def enrich(candidate: RawCandidate) -> RawCandidate | None:
            if candidate.summary and not candidate.authors:
                candidate.authors = [
                    clean_text(author)
                    for author in re.split(r"\s+(?:and|&)\s+|,\s*", candidate.summary)
                    if clean_text(author)
                ]
            if not await self.client.robots_allowed(candidate.url):
                return None
            response = await self.client.get(self.policy, url=candidate.url)
            if response is None:
                return None
            abstract = re.search(
                r"""<div[^>]+id=["']abstract["'][^>]*>.*?
                    <h3[^>]*>\s*Abstract\s*</h3>\s*(<p\b.*?</p>)""",
                response.text,
                flags=re.IGNORECASE | re.DOTALL | re.VERBOSE,
            )
            if not abstract:
                return None
            summary = clean_text(abstract.group(1))
            if len(summary) < 160:
                return None
            doi = ""
            doi_meta = re.search(
                r"""<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']+)["']""",
                response.text,
                flags=re.IGNORECASE,
            )
            if not doi_meta:
                doi_meta = re.search(
                    r"""<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_doi["']""",
                    response.text,
                    flags=re.IGNORECASE,
                )
            if doi_meta:
                doi = clean_text(doi_meta.group(1)).lower().removeprefix("https://doi.org/")
            candidate.summary = summary[:3000]
            candidate.doi = doi
            candidate.metadata["abstractSource"] = "official-article-page"
            return candidate

        enriched = await asyncio.gather(*(enrich(candidate) for candidate in candidates))
        return [candidate for candidate in enriched if candidate is not None]


class WikipediaFeaturedAdapter(SourceAdapter):
    @property
    def wiki_origin(self) -> str:
        host = urlparse(self.policy.endpoint).netloc
        if "zh.wikipedia" in host:
            return "https://zh.wikipedia.org"
        return "https://en.wikipedia.org"

    @property
    def chinese(self) -> bool:
        return "zh.wikipedia" in self.wiki_origin

    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        try:
            featured = await self._fetch_featured_rest(limit, offset)
            if featured:
                return featured
        except Exception:
            featured = []
        return await self._fetch_action_api(limit)

    async def _fetch_featured_rest(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        days = min(8 if limit >= 40 else 2, max(2, math.ceil(limit / 4)))
        collected: list[dict[str, Any]] = []
        seen: set[str] = set()
        today = datetime.now(timezone.utc).date()
        for day_index in range(offset, offset + days):
            day = today - timedelta(days=day_index)
            url = f"{self.policy.endpoint}/{day:%Y}/{day:%m}/{day:%d}"
            response = await self.client.get(self.policy, url=url)
            if response is None:
                continue
            payload = response.json()
            featured = payload.get("tfa") or {}
            self._collect_wikipedia_item(collected, seen, featured, day, kind="featured")
            for article in (payload.get("mostread") or {}).get("articles") or []:
                self._collect_wikipedia_item(collected, seen, article, day, kind="mostread")
            if len(collected) >= limit * 2:
                break
        selected = collected[: max(limit, 4)]
        enriched = await asyncio.gather(*(self._extract(item) for item in selected))
        return [item for item in enriched if item is not None][:limit]

    def _collect_wikipedia_item(
        self,
        collected: list[dict[str, Any]],
        seen: set[str],
        item: dict[str, Any],
        day,
        kind: str,
    ) -> None:
        titles = item.get("titles") or {}
        title = clean_text(titles.get("normalized") or titles.get("display") or item.get("title"))
        url = ((item.get("content_urls") or {}).get("desktop") or {}).get("page") or ""
        if not title or not url or title in seen:
            return
        seen.add(title)
        collected.append({
            "title": title,
            "url": url,
            "extract": clean_text(item.get("extract") or item.get("description") or ""),
            "published": datetime(day.year, day.month, day.day, tzinfo=timezone.utc),
            "kind": kind,
            "views": item.get("views") or 0,
        })

    async def _extract(self, item: dict[str, Any]) -> RawCandidate | None:
        api = f"{self.wiki_origin}/w/api.php"
        response = await self.client.get(
            self.policy,
            url=api,
            params={
                "action": "query",
                "format": "json",
                "prop": "extracts|info",
                "explaintext": 1,
                "exsectionformat": "plain",
                "redirects": 1,
                "titles": item["title"],
            },
        )
        extract = item["extract"]
        if response is not None:
            pages = ((response.json().get("query") or {}).get("pages") or {})
            page = next(iter(pages.values()), {})
            extract = page.get("extract") or extract
        if self.chinese:
            paragraphs = paragraphs_from_cjk_text(extract)
        else:
            paragraphs = select_reading_excerpt(paragraphs_from_plain_text(extract))
        if not paragraphs:
            return None
        summary = " ".join(paragraphs)[:1800]
        return self.candidate(
            external_id=item["title"],
            title=item["title"],
            url=item["url"] or f"{self.wiki_origin}/wiki/{quote(item['title'].replace(' ', '_'))}",
            published_at=item["published"],
            summary=summary,
            authors=["Wikipedia contributors"],
            metadata={
                "paragraphs": paragraphs,
                "wikipediaKind": item["kind"],
                "pageViews": item["views"],
                "sourceLanguage": "zh" if self.chinese else "en",
            },
        )

    async def _fetch_action_api(self, limit: int) -> list[RawCandidate]:
        response = await self.client.get(
            self.policy,
            url=f"{self.wiki_origin}/w/api.php",
            params={
                "action": "query",
                "format": "json",
                "generator": "categorymembers",
                "gcmtitle": "Category:特色条目" if self.chinese else "Category:Featured_articles",
                "gcmlimit": str(max(6, min(limit, 12))),
                "gcmnamespace": "0",
                "gcmsort": "timestamp",
                "gcmdir": "desc",
                "prop": "extracts|info|revisions",
                "explaintext": 1,
                "exsectionformat": "plain",
                "inprop": "url",
                "rvprop": "timestamp",
                "rvlimit": "1",
            },
        )
        if response is None:
            return []
        pages = ((response.json().get("query") or {}).get("pages") or {}).values()
        results = []
        for page in pages:
            title = clean_text(page.get("title"))
            extract = page.get("extract") or ""
            if self.chinese:
                paragraphs = paragraphs_from_cjk_text(extract)
            else:
                paragraphs = select_reading_excerpt(paragraphs_from_plain_text(extract))
            if not title or not paragraphs:
                continue
            timestamp = ((page.get("revisions") or [{}])[0]).get("timestamp")
            published = parse_date(timestamp) or datetime.now(timezone.utc)
            results.append(self.candidate(
                external_id=str(page.get("pageid") or title),
                title=title,
                url=page.get("fullurl") or f"{self.wiki_origin}/wiki/{quote(title.replace(' ', '_'))}",
                published_at=published,
                summary=" ".join(paragraphs)[:1800],
                authors=["Wikipedia contributors"],
                metadata={
                    "paragraphs": paragraphs,
                    "wikipediaKind": "featured-category",
                    "sourceLanguage": "zh" if self.chinese else "en",
                },
            ))
        return results[:limit]


GUTENBERG_CLASSICS = [
    {
        "id": 1342,
        "title": "Pride and Prejudice",
        "authors": ["Jane Austen"],
        "url": "https://www.gutenberg.org/files/1342/1342-0.txt",
    },
    {
        "id": 84,
        "title": "Frankenstein; Or, The Modern Prometheus",
        "authors": ["Mary Wollstonecraft Shelley"],
        "url": "https://www.gutenberg.org/files/84/84-0.txt",
    },
    {
        "id": 11,
        "title": "Alice’s Adventures in Wonderland",
        "authors": ["Lewis Carroll"],
        "url": "https://www.gutenberg.org/files/11/11-0.txt",
    },
    {
        "id": 1661,
        "title": "The Adventures of Sherlock Holmes",
        "authors": ["Arthur Conan Doyle"],
        "url": "https://www.gutenberg.org/files/1661/1661-0.txt",
    },
    {
        "id": 98,
        "title": "A Tale of Two Cities",
        "authors": ["Charles Dickens"],
        "url": "https://www.gutenberg.org/files/98/98-0.txt",
    },
    {
        "id": 345,
        "title": "Dracula",
        "authors": ["Bram Stoker"],
        "url": "https://www.gutenberg.org/files/345/345-0.txt",
    },
    {
        "id": 1260,
        "title": "Jane Eyre",
        "authors": ["Charlotte Brontë"],
        "url": "https://www.gutenberg.org/files/1260/1260-0.txt",
    },
    {
        "id": 36,
        "title": "The War of the Worlds",
        "authors": ["H. G. Wells"],
        "url": "https://www.gutenberg.org/files/36/36-0.txt",
    },
]


class GutenbergPopularAdapter(SourceAdapter):
    async def fetch(self, limit: int, offset: int = 0) -> list[RawCandidate]:
        try:
            response = await self.client.get(
                self.policy,
                params={
                    "languages": "en",
                    "copyright": "false",
                    "sort": "popular",
                    "page": max(1, offset // 32 + 1),
                },
            )
        except Exception:
            response = None
        books = []
        if response is not None:
            try:
                books = response.json().get("results") or []
            except ValueError:
                books = []
        if books:
            selected = books[: max(2, min(limit, 4))]
            enriched = await asyncio.gather(*(self._excerpt(book) for book in selected))
            found = [item for item in enriched if item is not None]
            if found:
                return found
        return await self._fallback_classics(limit)

    async def _fallback_classics(self, limit: int) -> list[RawCandidate]:
        selected = GUTENBERG_CLASSICS[: max(3, min(limit, len(GUTENBERG_CLASSICS)))]
        enriched = await asyncio.gather(*(self._excerpt_classic(book) for book in selected))
        return [item for item in enriched if item is not None]

    async def _excerpt_classic(self, book: dict[str, Any]) -> RawCandidate | None:
        return await self._excerpt({
            "id": book["id"],
            "title": book["title"],
            "authors": [{"name": name} for name in book["authors"]],
            "formats": {"text/plain; charset=utf-8": book["url"]},
            "download_count": 0,
            "subjects": ["literature"],
        })

    async def _excerpt(self, book: dict[str, Any]) -> RawCandidate | None:
        formats = book.get("formats") or {}
        text_url = (
            formats.get("text/plain; charset=us-ascii")
            or formats.get("text/plain; charset=utf-8")
            or formats.get("text/plain")
        )
        if not text_url:
            return None
        response = await self.client.get(self.policy, url=text_url, extra_headers={"Range": "bytes=0-39999"})
        if response is None:
            return None
        paragraphs = select_reading_excerpt(
            paragraphs_from_plain_text(response.text[:40000]),
            min_words=220,
            max_words=780,
        )
        if not paragraphs:
            return None
        authors = [item.get("name", "") for item in book.get("authors") or []]
        title = clean_text(book.get("title"))
        return self.candidate(
            external_id=str(book.get("id") or title),
            title=title,
            url=f"https://www.gutenberg.org/ebooks/{book.get('id')}",
            published_at=datetime(1924, 1, 1, tzinfo=timezone.utc),
            summary=" ".join(paragraphs)[:1800],
            authors=authors,
            metadata={
                "paragraphs": paragraphs,
                "downloadCount": book.get("download_count") or 0,
                "subjects": book.get("subjects") or [],
            },
        )


def build_adapters(settings: Settings, database: ContentDatabase) -> list[SourceAdapter]:
    client = RespectfulHttpClient(settings, database)
    adapters: list[SourceAdapter] = []
    for policy in SOURCE_POLICIES:
        if not policy.crawlAllowed or policy.status != "active":
            continue
        if policy.id == "crossref-api":
            adapters.append(CrossrefAdapter(policy, client))
        elif policy.id == "openalex-api":
            adapters.append(OpenAlexAdapter(policy, client))
        elif policy.id == "europe-pmc-api":
            adapters.append(EuropePmcAdapter(policy, client))
        elif policy.id == "arxiv-api":
            adapters.append(ArxivAdapter(policy, client))
        elif policy.id == "plos-api":
            adapters.append(PlosAdapter(policy, client))
        elif policy.id == "doaj-api":
            adapters.append(DoajAdapter(policy, client))
        elif policy.id == "worldbank-api":
            adapters.append(WorldBankAdapter(policy, client))
        elif policy.id in {"wikipedia-featured", "zhwiki-featured"}:
            adapters.append(WikipediaFeaturedAdapter(policy, client))
        elif policy.id == "gutenberg-popular":
            adapters.append(GutenbergPopularAdapter(policy, client))
        elif policy.id == "cdc-eid-rss":
            adapters.append(CdcEidAdapter(policy, client))
        elif policy.sourceType == "rss":
            adapters.append(RssAdapter(policy, client))
    adapters.sort(key=lambda adapter: (not adapter.policy.fullTextAllowed, adapter.policy.id))
    return adapters
