from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class SmsSendRequest(BaseModel):
    phone: str = Field(pattern=r"^1\d{10}$")


class SmsVerifyRequest(SmsSendRequest):
    code: str = Field(min_length=6, max_length=6)


class Preferences(BaseModel):
    level: Literal["A2", "B1", "B2", "C1"] = "B1"
    topics: list[str] = Field(default_factory=lambda: ["科技", "文化"], min_length=1, max_length=4)
    minutes: Literal[5, 10, 20] = 10
    reminder: str = "20:30"

    @field_validator("reminder")
    @classmethod
    def valid_time(cls, value: str) -> str:
        datetime.strptime(value, "%H:%M")
        return value


class PasswordLoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=8, max_length=128)


class TranslationRequest(BaseModel):
    sentence: str = Field(min_length=1, max_length=1200)
    before: str = Field(default="", max_length=1200)
    after: str = Field(default="", max_length=1200)
    targetLanguage: Literal["zh-CN"] = "zh-CN"
    word: str | None = Field(default=None, max_length=100)
    contentHash: str = Field(default="", max_length=128)
    qualityMode: Literal["free", "balanced", "precise"] = "free"


class SourcePolicy(BaseModel):
    id: str
    name: str
    license: str
    crawlAllowed: bool
    fullTextAllowed: bool
    attributionRequired: bool = True
    commercialAllowed: bool = False
    region: str = "CN"
    status: Literal["active", "review", "disabled"] = "review"
    sourceTier: Literal["A", "B", "C"] = "B"
    sourceType: Literal["api", "rss", "sitemap", "html", "editorial"] = "api"
    endpoint: str = ""
    topics: list[str] = Field(default_factory=list)
    peerReviewDefault: Literal["peer_reviewed", "preprint", "not_applicable", "unknown"] = "unknown"
    freshnessClass: Literal["news", "paper", "evergreen", "literature"] = "news"


class ContentRunRequest(BaseModel):
    limit: int | None = Field(default=None, ge=1, le=2000)
    generate: bool = False
    publish: bool = False


class ProviderOverrideItem(BaseModel):
    id: str = Field(min_length=2, max_length=40)
    label: str = ""
    kind: str = "openai"
    baseUrl: str = ""
    model: str = ""
    apiKey: str = ""
    enabled: bool = True
    cheapApi: bool = True
    clearKey: bool = False


class ProviderConfigRequest(BaseModel):
    order: list[str] = Field(default_factory=list)
    providers: list[ProviderOverrideItem] = Field(default_factory=list)


class ArticleReviewRequest(BaseModel):
    note: str = Field(default="", max_length=500)
