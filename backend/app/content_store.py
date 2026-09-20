from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    select,
)
from sqlalchemy import inspect, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .settings import Settings


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class SourcePolicyRecord(Base):
    __tablename__ = "source_policies"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    license: Mapped[str] = mapped_column(String(200))
    crawl_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    full_text_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    attribution_required: Mapped[bool] = mapped_column(Boolean, default=True)
    commercial_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    region: Mapped[str] = mapped_column(String(20), default="CN")
    status: Mapped[str] = mapped_column(String(20), default="review")
    source_tier: Mapped[str] = mapped_column(String(1), default="B")
    source_type: Mapped[str] = mapped_column(String(20), default="api")
    endpoint: Mapped[str] = mapped_column(Text, default="")
    topics: Mapped[list] = mapped_column(JSON, default=list)
    peer_review_default: Mapped[str] = mapped_column(String(30), default="unknown")
    freshness_class: Mapped[str] = mapped_column(String(20), default="news")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class SourceFetchState(Base):
    __tablename__ = "source_fetch_states"

    source_id: Mapped[str] = mapped_column(ForeignKey("source_policies.id"), primary_key=True)
    etag: Mapped[str] = mapped_column(Text, default="")
    last_modified: Mapped[str] = mapped_column(Text, default="")
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(Text, default="")
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    fetched_count: Mapped[int] = mapped_column(Integer, default=0)
    accepted_count: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0)
    health_score: Mapped[float] = mapped_column(Float, default=1.0)


class ContentCandidate(Base):
    __tablename__ = "content_candidates"
    __table_args__ = (
        UniqueConstraint("source_id", "external_id", name="uq_candidate_source_external"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    source_id: Mapped[str] = mapped_column(ForeignKey("source_policies.id"), index=True)
    external_id: Mapped[str] = mapped_column(String(300))
    doi: Mapped[str] = mapped_column(String(300), default="", index=True)
    canonical_url: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text, default="")
    authors: Mapped[list] = mapped_column(JSON, default=list)
    source_published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    topic: Mapped[str] = mapped_column(String(30), index=True)
    content_kind: Mapped[str] = mapped_column(String(20), default="news")
    peer_review_status: Mapped[str] = mapped_column(String(30), default="unknown")
    source_tier: Mapped[str] = mapped_column(String(1), default="B")
    license: Mapped[str] = mapped_column(String(200), default="")
    full_text_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    raw_hash: Mapped[str] = mapped_column(String(64), index=True)
    title_fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    quality_score: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[str] = mapped_column(String(30), default="accepted", index=True)
    rejection_reason: Mapped[str] = mapped_column(Text, default="")
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class StoryCluster(Base):
    __tablename__ = "story_clusters"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    topic: Mapped[str] = mapped_column(String(30), index=True)
    canonical_title: Mapped[str] = mapped_column(Text)
    candidate_ids: Mapped[list] = mapped_column(JSON, default=list)
    independent_source_ids: Mapped[list] = mapped_column(JSON, default=list)
    evidence_score: Mapped[float] = mapped_column(Float, default=0)
    risk_level: Mapped[str] = mapped_column(String(20), default="low")
    status: Mapped[str] = mapped_column(String(30), default="ready")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class FactClaim(Base):
    __tablename__ = "fact_claims"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    story_cluster_id: Mapped[str] = mapped_column(ForeignKey("story_clusters.id"), index=True)
    claim: Mapped[str] = mapped_column(Text)
    source_url: Mapped[str] = mapped_column(Text)
    source_label: Mapped[str] = mapped_column(String(300))
    evidence_locator: Mapped[str] = mapped_column(String(300), default="")
    verified: Mapped[bool] = mapped_column(Boolean, default=False)


class ArticleVariant(Base):
    __tablename__ = "article_variants"
    __table_args__ = (
        UniqueConstraint("story_cluster_id", "cefr", "body_hash", name="uq_article_story_level_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    story_cluster_id: Mapped[str] = mapped_column(ForeignKey("story_clusters.id"), index=True)
    source_candidate_id: Mapped[str] = mapped_column(ForeignKey("content_candidates.id"), index=True)
    title: Mapped[str] = mapped_column(Text)
    author: Mapped[str] = mapped_column(String(200), default="苏打阅读编辑部")
    summary: Mapped[str] = mapped_column(Text)
    intro_zh: Mapped[str] = mapped_column(Text, default="")
    paragraphs: Mapped[list] = mapped_column(JSON, default=list)
    sentence_translations: Mapped[dict] = mapped_column(JSON, default=dict)
    glossary: Mapped[list] = mapped_column(JSON, default=list)
    body_hash: Mapped[str] = mapped_column(String(64), index=True)
    cefr: Mapped[str] = mapped_column(String(4), index=True)
    word_count: Mapped[int] = mapped_column(Integer)
    reading_minutes: Mapped[int] = mapped_column(Integer)
    topic: Mapped[str] = mapped_column(String(30), index=True)
    content_mode: Mapped[str] = mapped_column(String(30), default="editorial_digest")
    peer_review_status: Mapped[str] = mapped_column(String(30), default="not_applicable")
    quality_score: Mapped[float] = mapped_column(Float, default=0)
    difficulty_metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    source_published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sources: Mapped[list] = mapped_column(JSON, default=list)
    risk_flags: Mapped[list] = mapped_column(JSON, default=list)
    review_status: Mapped[str] = mapped_column(String(30), default="review", index=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PipelineRun(Base):
    __tablename__ = "pipeline_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    kind: Mapped[str] = mapped_column(String(30), default="discovery")
    status: Mapped[str] = mapped_column(String(30), default="running", index=True)
    requested_limit: Mapped[int] = mapped_column(Integer, default=0)
    fetched_count: Mapped[int] = mapped_column(Integer, default=0)
    accepted_count: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0)
    rejected_count: Mapped[int] = mapped_column(Integer, default=0)
    generated_count: Mapped[int] = mapped_column(Integer, default=0)
    published_count: Mapped[int] = mapped_column(Integer, default=0)
    source_stats: Mapped[dict] = mapped_column(JSON, default=dict)
    topic_coverage: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DailyEdition(Base):
    __tablename__ = "daily_editions"

    edition_date: Mapped[date] = mapped_column(Date, primary_key=True)
    status: Mapped[str] = mapped_column(String(30), default="staging")
    article_ids: Mapped[list] = mapped_column(JSON, default=list)
    coverage: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DailyRecommendation(Base):
    __tablename__ = "daily_recommendations"
    __table_args__ = (
        UniqueConstraint("user_id", "recommendation_date", name="uq_daily_recommendation_user_date"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(String(100), index=True)
    recommendation_date: Mapped[date] = mapped_column(Date, index=True)
    primary_article_id: Mapped[str] = mapped_column(String(36))
    alternative_article_ids: Mapped[list] = mapped_column(JSON, default=list)
    reasons: Mapped[dict] = mapped_column(JSON, default=dict)
    scores: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class ContentDatabase:
    def __init__(self, settings: Settings):
        self.settings = settings
        if settings.database_url.startswith("sqlite:///"):
            raw_path = settings.database_url.removeprefix("sqlite:///")
            Path(raw_path).parent.mkdir(parents=True, exist_ok=True)
        connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
        self.engine = create_engine(settings.database_url, future=True, pool_pre_ping=True, connect_args=connect_args)
        self.session_factory = sessionmaker(self.engine, expire_on_commit=False, class_=Session)

    def initialize(self) -> None:
        # Supabase SQL migrations are the production schema authority. Creating
        # tables from ORM metadata remains useful for isolated SQLite tests only.
        if self.settings.app_env == "development" or self.settings.database_url.startswith("sqlite"):
            Base.metadata.create_all(self.engine)
            inspector = inspect(self.engine)
            if "article_variants" in inspector.get_table_names():
                columns = {column["name"] for column in inspector.get_columns("article_variants")}
                if "intro_zh" not in columns:
                    with self.engine.begin() as connection:
                        connection.execute(text("ALTER TABLE article_variants ADD COLUMN intro_zh TEXT DEFAULT ''"))

    @contextmanager
    def session(self) -> Iterator[Session]:
        session = self.session_factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def latest_run(self) -> PipelineRun | None:
        with self.session() as session:
            return session.scalar(select(PipelineRun).order_by(PipelineRun.started_at.desc()).limit(1))
