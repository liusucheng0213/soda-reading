from datetime import datetime, timedelta, timezone
from secrets import compare_digest, token_urlsafe

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .content import ContentService
from .provider_config import public_config, save_overrides
from .schemas import (
    ArticleReviewRequest,
    ContentRunRequest,
    PasswordLoginRequest,
    Preferences,
    ProgressRequest,
    ProviderConfigRequest,
    SmsSendRequest,
    SmsVerifyRequest,
    TranslationRequest,
    VocabularyRequest,
)
from .settings import Settings, get_settings
from .translation import TranslationGateway, TranslationUnavailable

app = FastAPI(title="苏打阅读 API", version="0.1.0")
settings = get_settings()
gateway = TranslationGateway(settings)
content_service = ContentService(settings)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

sms_requests: dict[str, datetime] = {}
sessions: dict[str, dict] = {}
profiles: dict[str, dict] = {}
progress_store: dict[str, dict] = {}
vocabulary_store: dict[str, list[dict]] = {}


def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="需要登录")
    token = authorization.removeprefix("Bearer ")
    user = sessions.get(token)
    if not user:
        raise HTTPException(status_code=401, detail="登录已失效")
    return user


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


@app.post("/auth/sms/send")
async def send_sms(payload: SmsSendRequest) -> dict:
    if settings.app_env != "development":
        raise HTTPException(
            status_code=503,
            detail={
                "code": "SMS_PROVIDER_NOT_CONFIGURED",
                "message": "生产短信服务尚未接入",
                "retryable": False,
            },
        )
    sms_requests[payload.phone] = datetime.now(timezone.utc) + timedelta(minutes=5)
    response = {"requestId": token_urlsafe(12), "expiresIn": 300, "provider": "development"}
    if settings.app_env == "development":
        response["devCode"] = settings.dev_sms_code
    return response


@app.post("/auth/sms/verify")
async def verify_sms(payload: SmsVerifyRequest) -> dict:
    if settings.app_env != "development":
        raise HTTPException(
            status_code=503,
            detail={
                "code": "SMS_PROVIDER_NOT_CONFIGURED",
                "message": "生产短信服务尚未接入",
                "retryable": False,
            },
        )
    expires = sms_requests.get(payload.phone)
    if not expires or expires < datetime.now(timezone.utc) or payload.code != settings.dev_sms_code:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    token = token_urlsafe(32)
    user = {"id": f"user-{payload.phone[-4:]}", "phone": payload.phone}
    sessions[token] = user
    profiles.setdefault(user["id"], Preferences().model_dump())
    return {"accessToken": token, "user": user}


@app.post("/auth/password/login")
async def password_login(payload: PasswordLoginRequest) -> dict:
    username = payload.username.strip().lower()
    if settings.app_env != "development":
        raise HTTPException(status_code=503, detail="请使用云端账号登录")
    if username != "admin" or payload.password != "Soda-local-2026!":
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    token = token_urlsafe(32)
    user = {"id": "local-admin", "username": "admin"}
    sessions[token] = user
    profiles.setdefault(user["id"], Preferences(level="B1", topics=["科技", "文化"]).model_dump())
    return {
        "accessToken": token,
        "user": user,
        "profile": {
            "username": "admin",
            "role": "admin",
            "level": "B1",
            "topics": ["科技", "文化"],
            "minutes": 10,
            "reminder": "20:30",
            "reviewLimit": 20,
            "mustChangePassword": False,
            "onboarded": True,
        },
    }


@app.get("/profile/preferences")
async def get_preferences(user: dict = Depends(current_user)) -> dict:
    return profiles.setdefault(user["id"], Preferences().model_dump())


@app.put("/profile/preferences")
async def put_preferences(payload: Preferences, user: dict = Depends(current_user)) -> dict:
    profiles[user["id"]] = payload.model_dump()
    return profiles[user["id"]]


@app.get("/feed/daily")
async def feed(user: dict = Depends(current_user)) -> dict:
    return content_service.daily_feed(
        profiles.setdefault(user["id"], Preferences().model_dump()),
        user["id"],
    )


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


@app.put("/reading-progress")
async def save_progress(payload: ProgressRequest, user: dict = Depends(current_user)) -> dict:
    key = f"{user['id']}:{payload.contentHash or payload.contentId}"
    progress_store[key] = payload.model_dump()
    return {"saved": True, **progress_store[key]}


@app.post("/vocabulary")
async def save_vocabulary(payload: VocabularyRequest, user: dict = Depends(current_user)) -> dict:
    items = vocabulary_store.setdefault(user["id"], [])
    item = payload.model_dump()
    if not any(existing["contentId"] == item["contentId"] and existing["word"].lower() == item["word"].lower() for existing in items):
        items.append(item)
    return {"saved": True, "count": len(items), "item": item}


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
    save_overrides(payload.model_dump())
    gateway = TranslationGateway(settings)
    return {"saved": True, "config": public_config(), "providers": gateway.provider_status()}


@app.get("/admin/translation", dependencies=[Depends(require_admin)])
async def admin_translation() -> dict:
    return gateway.overview()


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
