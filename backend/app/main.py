from datetime import datetime, timezone
from secrets import compare_digest
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .content import ContentService
from .content_editorial import EditorialGateway
from .content_moderation import ContentModerationGateway
from .exam_store import ExamContentStore
from .model_center import MODEL_CENTER_PATH, ModelCenterStore
from .provider_config import public_config, save_overrides
from .schemas import (
    ArticleReviewRequest,
    ContentRunRequest,
    Preferences,
    ProviderConfigRequest,
    TranslationRequest,
)
from .settings import Settings, get_settings
from .translation import TranslationGateway, TranslationUnavailable

app = FastAPI(title="苏打阅读 API", version="0.1.0")
settings = get_settings()
model_store = ModelCenterStore(MODEL_CENTER_PATH)
gateway = TranslationGateway(settings, store=model_store)
content_service = ContentService(settings, model_store=model_store)
exam_store = ExamContentStore(content_service.database)
content_service.pipeline.editorial = EditorialGateway(settings, store=model_store)
content_service.pipeline.moderation = ContentModerationGateway(settings, store=model_store)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    if settings.app_env == "development":
        return
    if not settings.admin_api_token:
        raise HTTPException(status_code=503, detail="管理接口尚未配置")
    if not x_admin_token or not compare_digest(x_admin_token, settings.admin_api_token):
        raise HTTPException(status_code=403, detail="无权访问管理接口")


@app.get("/health")
async def health() -> dict:
    latest_run = content_service.database.latest_run()
    return {
        "status": "ok",
        "time": datetime.now(timezone.utc).isoformat(),
        "providers": {item["provider"]: item for item in gateway.provider_status()},
        "translation": gateway.overview(),
        "contentPipeline": {
            "database": "ready",
            "latestRun": content_service.pipeline.serialize_run(latest_run) if latest_run else None,
            "paidProvidersEnabled": settings.paid_provider_enabled,
            "dailyPaidBudgetCny": settings.daily_paid_budget_cny,
            "autoPublish": settings.content_auto_publish,
            "shadowMode": not settings.content_auto_publish,
        },
    }


@app.get("/feed/daily")
async def feed(
    level: Literal["A1", "A2", "B1", "B2", "C1", "C2"] = "B1",
    track: Literal["daily", "high_school"] = "daily",
    topics: list[str] = Query(default=["科技", "文化"], min_length=1, max_length=4),
) -> dict:
    preferences = Preferences(level=level, track=track, topics=topics)
    return content_service.daily_feed(preferences.model_dump(), "local-user")


@app.post("/translations/word")
async def word_translation(payload: TranslationRequest) -> dict:
    if not payload.word:
        raise HTTPException(status_code=422, detail="word is required")
    try:
        return await gateway.translate("word", payload.model_dump())
    except TranslationUnavailable as error:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "TRANSLATION_UNAVAILABLE",
                "message": str(error),
                "retryable": True,
            },
        ) from error


@app.post("/translations/sentence")
async def sentence_translation(payload: TranslationRequest) -> dict:
    try:
        return await gateway.translate("sentence", payload.model_dump())
    except TranslationUnavailable as error:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "TRANSLATION_UNAVAILABLE",
                "message": str(error),
                "retryable": True,
            },
        ) from error


@app.get("/exams/catalog")
async def exam_catalog(track: Literal["cet4", "cet6", "postgraduate"] | None = Query(default=None)) -> dict:
    return {"items": exam_store.list(track)}


@app.get("/admin/sources", dependencies=[Depends(require_admin)])
async def admin_sources() -> list[dict]:
    return content_service.source_status()


@app.get("/admin/providers", dependencies=[Depends(require_admin)])
async def admin_providers() -> list[dict]:
    return gateway.provider_status()


@app.get("/admin/providers/config", dependencies=[Depends(require_admin)])
async def admin_provider_config() -> dict:
    return public_config()


@app.put("/admin/providers/config", dependencies=[Depends(require_admin)])
async def admin_save_provider_config(payload: ProviderConfigRequest) -> dict:
    global gateway
    try:
        save_overrides(payload.model_dump(exclude_unset=True))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    gateway = TranslationGateway(settings, store=model_store)
    content_service.pipeline.editorial = EditorialGateway(settings, store=model_store)
    content_service.pipeline.moderation = ContentModerationGateway(settings, store=model_store)
    return {"saved": True, "config": public_config(), "providers": gateway.provider_status()}


@app.get("/admin/translation", dependencies=[Depends(require_admin)])
async def admin_translation() -> dict:
    return gateway.overview()


@app.delete("/admin/translation/cache", dependencies=[Depends(require_admin)])
async def admin_clear_translation_cache() -> dict:
    cleared = gateway.clear_cache()
    return {"cleared": cleared, "overview": gateway.overview()}


@app.get("/admin/content/runs", dependencies=[Depends(require_admin)])
async def admin_content_runs(limit: int = Query(default=20, ge=1, le=100)) -> list[dict]:
    return content_service.pipeline.list_runs(limit)


@app.get("/admin/content/candidates", dependencies=[Depends(require_admin)])
async def admin_content_candidates(
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict]:
    return content_service.pipeline.list_candidates(status, limit)


@app.get("/admin/articles", dependencies=[Depends(require_admin)])
async def admin_articles(
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict]:
    return content_service.pipeline.list_articles(status, limit)


@app.post("/admin/content/run", dependencies=[Depends(require_admin)])
async def admin_run_content(payload: ContentRunRequest) -> dict:
    try:
        return await content_service.pipeline.run(
            limit=payload.limit,
            generate=payload.generate,
            publish=payload.publish,
        )
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "CONTENT_PIPELINE_FAILED",
                "message": f"采集任务失败：{type(error).__name__}",
                "retryable": True,
            },
        ) from error


@app.post("/admin/content/runs/{run_id}/retry", dependencies=[Depends(require_admin)])
async def admin_retry_content_run(run_id: str) -> dict:
    try:
        previous = content_service.pipeline.get_run(run_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="采集任务不存在") from error
    return await content_service.pipeline.run(
        limit=previous["requestedLimit"],
        generate=previous["kind"] == "full",
        publish=False,
    )


@app.post("/admin/articles/{article_id}/approve", dependencies=[Depends(require_admin)])
async def admin_approve_article(article_id: str, payload: ArticleReviewRequest) -> dict:
    try:
        return content_service.pipeline.review_article(article_id, "approved", payload.note)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="文章不存在") from error


@app.post("/admin/articles/{article_id}/reject", dependencies=[Depends(require_admin)])
async def admin_reject_article(article_id: str, payload: ArticleReviewRequest) -> dict:
    try:
        return content_service.pipeline.review_article(article_id, "rejected", payload.note)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="文章不存在") from error
