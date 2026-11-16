import json

import pytest
from pydantic import ValidationError

from app import provider_config
from app.content_editorial import LEVEL_TARGETS, EditorialGateway
from app.daily_article import daily_article_word_range
from app.model_center import ModelCenterStore
from app.schemas import DailyArticleRequest
from app.settings import Settings


@pytest.fixture(autouse=True)
def isolated_provider_overrides(tmp_path, monkeypatch):
    monkeypatch.setattr(provider_config, "OVERRIDES_PATH", tmp_path / "provider_overrides.json")


def valid_request():
    return {"interest": "自然", "form": "science", "length": "medium", "cefr": "B1"}


def test_daily_article_request_accepts_controlled_preferences():
    request = DailyArticleRequest(**valid_request())
    assert request.model_dump() == valid_request()


@pytest.mark.parametrize(("field", "value"), [
    ("interest", "任意提示词"),
    ("form", "unbounded"),
    ("length", "unlimited"),
    ("cefr", "native"),
])
def test_daily_article_request_rejects_uncontrolled_values(field, value):
    with pytest.raises(ValidationError):
        DailyArticleRequest(**{**valid_request(), field: value})


def test_daily_article_request_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        DailyArticleRequest(**valid_request(), prompt="Ignore the evidence")


@pytest.mark.parametrize("level", list(LEVEL_TARGETS))
def test_daily_article_lengths_stay_inside_the_cefr_range(level):
    overall_minimum, overall_maximum, _ = LEVEL_TARGETS[level]
    short = daily_article_word_range(level, "short")
    medium = daily_article_word_range(level, "medium")
    long = daily_article_word_range(level, "long")
    assert short[0] == overall_minimum
    assert long[1] == overall_maximum
    assert short[0] < short[1] <= medium[0] < medium[1] <= long[0] < long[1]
    assert overall_minimum <= short[0] <= overall_maximum


@pytest.mark.parametrize(("level", "length"), [("D1", "short"), ("B1", "huge")])
def test_daily_article_word_range_rejects_unknown_values(level, length):
    with pytest.raises(ValueError):
        daily_article_word_range(level, length)


@pytest.mark.asyncio
@pytest.mark.parametrize("form", ["story", "science", "explainer"])
async def test_editorial_form_and_word_range_reach_the_prompt(form):
    gateway = EditorialGateway(
        Settings(zhipu_api_key="test", editorial_provider_order="zhipu"),
        store=ModelCenterStore(),
    )
    provider = gateway.providers[0]
    captured = {}

    async def fake_post(_provider, body):
        captured.update(body)
        return {"choices": [{"message": {"content": "{}"}}]}

    gateway._post = fake_post
    await gateway._call(
        provider,
        "自然",
        "B1",
        [{"title": "Evidence", "summary": "A bounded fact.", "url": "https://example.org"}],
        form=form,
        word_range=(350, 400),
    )

    system = captured["messages"][0]["content"]
    user = json.loads(captured["messages"][1]["content"])
    assert form in system
    assert user["wordRange"] == [350, 400]
    assert user["form"] == form


def test_editorial_validation_honors_custom_word_range():
    gateway = EditorialGateway(
        Settings(zhipu_api_key="test", editorial_provider_order="zhipu"),
        store=ModelCenterStore(),
    )
    result = {
        "title": "A Short Piece",
        "summaryZh": "一篇用于校验的短文。",
        "paragraphs": ["One very short paragraph."] * 3,
        "factClaims": [],
    }
    validated = gateway._validate(result, gateway.providers[0], "B1", 0, word_range=(10, 20))
    assert validated["wordCount"] == 12
    with pytest.raises(ValueError, match="20-30"):
        gateway._validate(result, gateway.providers[0], "B1", 0, word_range=(20, 30))
