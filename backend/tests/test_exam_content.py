import json
from copy import deepcopy
from datetime import date, datetime, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import inspect, select, text

from app.content import ContentService
from app.content_store import ArticleVariant, ContentDatabase, DailyEdition, SourcePolicyRecord
from app.exam_content import validate_exam_passage
from app.exam_store import ExamContentStore
from app.settings import Settings


def valid_passage():
    paragraph = "Small community gardens give neighbors a shared place to grow food. They also create opportunities to learn from one another."
    return {
        "id": "cet4-garden-science-original",
        "title": "The Shared Work of a Community Garden",
        "author": "苏打阅读编辑部",
        "topic": "自然",
        "cefr": "B2",
        "publishedAt": "2026-11-15T08:00:00+08:00",
        "introZh": "从社区花园看合作、学习与城市生活之间的联系。",
        "paragraphs": [paragraph, "A garden needs steady care, so members often divide tasks and share what they learn."],
        "examTrack": "cet4",
        "contentOrigin": "original",
        "year": None,
        "session": "",
        "region": "",
        "paper": "",
        "questions": [
            {
                "id": f"q{index}",
                "prompt": f"Question {index}",
                "options": ["Growing food", "Building roads", "Selling cars", "Closing parks"],
                "answer": "A",
                "explanationZh": "原文明确说明花园提供共同种植食物的空间。",
                "evidenceParagraph": 0,
                "evidenceSentence": "Small community gardens give neighbors a shared place to grow food.",
            }
            for index in range(1, 5)
        ],
        "provenance": {
            "sourceLabel": "苏打阅读原创模拟",
            "sourceId": "cet4-garden-science-original",
            "sourceUrl": None,
            "retrievedAt": None,
            "license": "项目原创",
            "usageBasis": "原创模拟内容，不对应任何真实试卷。",
        },
        "sourceReviewedAt": "2026-11-15T09:00:00+08:00",
        "answersReviewedAt": "2026-11-15T09:30:00+08:00",
    }


def test_valid_original_passage_preserves_stable_identity():
    passage = validate_exam_passage(valid_passage())
    assert passage.id == "cet4-garden-science-original"
    assert len(passage.questions) == 4


@pytest.mark.parametrize("track", ["high_school", "cet4", "cet6", "postgraduate"])
def test_all_exam_tracks_are_accepted(track):
    payload = valid_passage()
    payload["examTrack"] = track
    assert validate_exam_passage(payload).exam_track == track


@pytest.mark.parametrize("track", ["CET4", "ielts", ""])
def test_unknown_exam_tracks_are_rejected(track):
    payload = valid_passage()
    payload["examTrack"] = track
    with pytest.raises(ValidationError):
        validate_exam_passage(payload)


@pytest.mark.parametrize(("field", "value"), [
    ("options", ["A", "B", "C"]),
    ("options", ["Same", "Same", "Different", "Other"]),
    ("options", ["", "B", "C", "D"]),
    ("answer", "E"),
    ("answer", "a"),
])
def test_invalid_question_shapes_are_rejected(field, value):
    payload = valid_passage()
    payload["questions"][0][field] = value
    with pytest.raises(ValidationError):
        validate_exam_passage(payload)


def test_question_ids_must_be_unique_within_a_passage():
    payload = valid_passage()
    payload["questions"][1]["id"] = "q1"
    with pytest.raises(ValueError, match="q1"):
        validate_exam_passage(payload)


@pytest.mark.parametrize(("field", "value"), [
    ("evidenceParagraph", 1),
    ("evidenceSentence", "Small community gardens give neighbors a shared place to grow food?"),
    ("evidenceSentence", "Small community gardens give neighbors"),
])
def test_evidence_must_be_a_complete_sentence_in_the_selected_paragraph(field, value):
    payload = valid_passage()
    payload["questions"][0][field] = value
    with pytest.raises(ValueError, match="q1"):
        validate_exam_passage(payload)


@pytest.mark.parametrize("origin", ["official_exam", "licensed_exam", "adapted", "original"])
def test_content_origins_are_controlled(origin):
    payload = valid_passage()
    payload["contentOrigin"] = origin
    if origin in {"official_exam", "licensed_exam", "adapted"}:
        payload["year"] = 2024
        payload["provenance"].update({
            "sourceUrl": "https://example.org/passage",
            "retrievedAt": "2026-11-15T08:30:00+08:00",
            "license": "明确授权",
            "usageBasis": "已核验使用依据",
        })
    assert validate_exam_passage(payload).content_origin == origin


@pytest.mark.parametrize("origin", ["official_exam", "licensed_exam", "adapted"])
def test_external_content_requires_traceable_reviewed_provenance(origin):
    payload = valid_passage()
    payload["contentOrigin"] = origin
    payload["year"] = 2024 if origin != "adapted" else None
    with pytest.raises(ValidationError):
        validate_exam_passage(payload)


@pytest.mark.parametrize("origin", ["official_exam", "licensed_exam"])
def test_real_exam_claims_require_a_reasonable_year(origin):
    payload = valid_passage()
    payload["contentOrigin"] = origin
    payload["provenance"].update({
        "sourceUrl": "http://example.org/passage",
        "retrievedAt": "2026-11-15T08:30:00+08:00",
        "license": "明确授权",
        "usageBasis": "已核验使用依据",
    })
    with pytest.raises(ValidationError):
        validate_exam_passage(payload)


def test_unknown_or_conflicting_claims_are_rejected():
    payload = valid_passage()
    payload["officialExam"] = True
    with pytest.raises(ValidationError):
        validate_exam_passage(payload)


def test_existing_sqlite_is_upgraded_and_regular_articles_stay_unscoped(tmp_path):
    path = tmp_path / "legacy.db"
    settings = Settings(database_url=f"sqlite:///{path}")
    database = ContentDatabase(settings)
    with database.engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE article_variants (
                id VARCHAR(36) PRIMARY KEY,
                story_cluster_id VARCHAR(36) NOT NULL,
                source_candidate_id VARCHAR(36) NOT NULL,
                title TEXT NOT NULL,
                author VARCHAR(200) NOT NULL,
                summary TEXT NOT NULL,
                paragraphs JSON NOT NULL,
                sentence_translations JSON NOT NULL,
                glossary JSON NOT NULL,
                body_hash VARCHAR(64) NOT NULL,
                cefr VARCHAR(4) NOT NULL,
                word_count INTEGER NOT NULL,
                reading_minutes INTEGER NOT NULL,
                topic VARCHAR(30) NOT NULL,
                content_mode VARCHAR(30) NOT NULL,
                peer_review_status VARCHAR(30) NOT NULL,
                quality_score FLOAT NOT NULL,
                difficulty_metrics JSON NOT NULL,
                source_published_at DATETIME NOT NULL,
                sources JSON NOT NULL,
                risk_flags JSON NOT NULL,
                review_status VARCHAR(30) NOT NULL,
                review_note TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                published_at DATETIME
            )
        """))
    database.initialize()
    database.initialize()

    columns = {column["name"] for column in inspect(database.engine).get_columns("article_variants")}
    assert {"exam_track", "content_origin", "exam_metadata", "questions", "provenance", "intro_zh"} <= columns
    with database.session() as session:
        session.execute(text("""
            INSERT INTO article_variants (
                id, story_cluster_id, source_candidate_id, title, author, summary, intro_zh,
                paragraphs, sentence_translations, glossary, body_hash, cefr, word_count,
                reading_minutes, topic, content_mode, peer_review_status, quality_score,
                difficulty_metrics, source_published_at, sources, risk_flags, review_status,
                review_note, created_at
            ) VALUES (
                'ordinary', 'cluster', 'candidate', 'Ordinary', 'Author', 'Summary', '导读',
                '["A complete paragraph."]', '{}', '[]', 'hash', 'B1', 3,
                2, '文化', 'licensed_original', 'not_applicable', 80,
                '{}', '2026-11-15 00:00:00', '[]', '[]', 'approved', '', '2026-11-15 00:00:00'
            )
        """))
    with database.session() as session:
        article = session.scalar(select(ArticleVariant).where(ArticleVariant.id == "ordinary"))
        serialized = ContentService._article_dict(article, 0)
        assert serialized["examTrack"] is None
        assert serialized["contentOrigin"] is None
        assert serialized["questions"] == []
        assert serialized["exam"] is None
        assert serialized["provenance"] is None


def exam_database(tmp_path):
    database = ContentDatabase(Settings(database_url=f"sqlite:///{tmp_path / 'exams.db'}"))
    database.initialize()
    return database


def test_import_is_idempotent_and_list_filters_by_track(tmp_path):
    store = ExamContentStore(exam_database(tmp_path))
    imported = store.import_passage(valid_passage())
    assert imported["id"] == valid_passage()["id"]
    assert imported["examTrack"] == "cet4"
    assert imported["questions"][0]["answer"] == "A"
    assert imported["exam"]["year"] is None
    assert store.import_passage(valid_passage())["id"] == imported["id"]
    assert len(store.list("cet4")) == 1
    assert store.list("cet6") == []


def test_same_id_cannot_replace_article_body(tmp_path):
    store = ExamContentStore(exam_database(tmp_path))
    store.import_passage(valid_passage())
    changed = valid_passage()
    changed["paragraphs"][1] = "A different paragraph now describes an entirely different article."
    with pytest.raises(ValueError, match="正文"):
        store.import_passage(changed)
    assert store.list()[0]["paragraphs"] == valid_passage()["paragraphs"]


def test_invalid_batch_rolls_back_every_article(tmp_path):
    store = ExamContentStore(exam_database(tmp_path))
    second = valid_passage()
    second["id"] = "cet6-garden-story-original"
    second["examTrack"] = "cet6"
    second["questions"][0]["evidenceSentence"] = "This sentence is absent from the article."
    with pytest.raises(ValueError, match="q1"):
        store.import_passages([valid_passage(), second])
    assert store.list() == []


def test_only_approved_exam_articles_appear_in_catalog(tmp_path):
    database = exam_database(tmp_path)
    store = ExamContentStore(database)
    imported = store.import_passage(valid_passage())
    with database.session() as session:
        session.get(ArticleVariant, imported["id"]).review_status = "review"
    assert store.list() == []


@pytest.mark.parametrize(("path", "value"), [
    (("questions", 0, "answer"), "B"),
    (("questions", 0, "explanationZh"), "修订后的解析不应被静默忽略。"),
    (("questions", 0, "evidenceSentence"), "They also create opportunities to learn from one another."),
    (("examTrack",), "cet6"),
    (("cefr",), "C1"),
    (("title",), "A Revised Title"),
    (("contentOrigin",), "adapted"),
])
def test_same_id_rejects_any_unversioned_content_change(tmp_path, path, value):
    store = ExamContentStore(exam_database(tmp_path))
    store.import_passage(valid_passage())
    original = store.list()[0]
    changed = valid_passage()
    target = changed
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    if changed["contentOrigin"] == "adapted":
        changed["provenance"].update({
            "sourceUrl": "https://example.org/revised",
            "retrievedAt": "2026-11-15T10:00:00+08:00",
            "license": "明确授权",
            "usageBasis": "已核验改编使用依据",
        })
    with pytest.raises(ValueError, match="内容包"):
        store.import_passage(changed)
    assert store.list()[0] == original


def test_evidence_handles_titles_and_rejects_multiple_sentences():
    payload = valid_passage()
    payload["paragraphs"][0] = "Mr. Bell opened the bakery. He smiled at the visitors."
    for question in payload["questions"][1:]:
        question["evidenceParagraph"] = 1
        question["evidenceSentence"] = "A garden needs steady care, so members often divide tasks and share what they learn."
    payload["questions"][0]["evidenceSentence"] = "Mr. Bell opened the bakery."
    assert validate_exam_passage(payload).questions[0].evidence_sentence == "Mr. Bell opened the bakery."

    payload["paragraphs"][0] = 'Eli paused: "Leave room for a question." No one explained it.'
    payload["questions"][0]["evidenceSentence"] = payload["paragraphs"][0]
    with pytest.raises(ValueError, match="q1"):
        validate_exam_passage(payload)


def test_high_school_packages_enter_daily_pool_without_replacing_existing_edition(tmp_path):
    content_dir = Path(__file__).parent.parent / "content" / "high-school"
    paths = sorted(content_dir.glob("*.json"))
    assert len(paths) == 4
    payloads = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    assert {payload["cefr"] for payload in payloads} >= {"A2", "B1", "B2"}
    assert all(payload["examTrack"] == "high_school" for payload in payloads)
    assert all(payload["contentOrigin"] == "original" for payload in payloads)
    assert sum(len(payload["questions"]) for payload in payloads) == 16

    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'high-school-daily.db'}",
        editorial_provider_order="",
    )
    service = ContentService(settings)
    store = ExamContentStore(service.database)
    cet = store.import_passage(valid_passage())
    imported = store.import_passages(payloads)
    assert imported["added"] == 4
    assert store.import_passages(payloads)["added"] == 0
    assert [item["id"] for item in store.list()] == [cet["id"]]
    assert len(store.list("high_school")) == 4

    with service.database.session() as session:
        cet_article = session.get(ArticleVariant, cet["id"])
        for index in range(3):
            session.add(ArticleVariant(
                id=f"ordinary-daily-{index}",
                story_cluster_id=cet_article.story_cluster_id,
                source_candidate_id=cet_article.source_candidate_id,
                title=f"Ordinary daily reading {index}",
                author="苏打阅读编辑部",
                summary="普通每日阅读导读。",
                intro_zh="普通每日阅读导读。",
                paragraphs=valid_passage()["paragraphs"],
                sentence_translations={},
                glossary=[],
                body_hash=f"ordinary-daily-hash-{index}",
                cefr="B1",
                word_count=40,
                reading_minutes=2,
                topic="文化",
                content_mode="editorial_digest",
                peer_review_status="not_applicable",
                quality_score=90,
                difficulty_metrics={},
                source_published_at=datetime.now(timezone.utc),
                sources=[],
                risk_flags=[],
                review_status="approved",
                created_at=datetime.now(timezone.utc),
            ))

    target = date(2026, 11, 16)
    published = service.pipeline.publish_today(target)
    assert published == 5
    with service.database.session() as session:
        original_ids = list(session.get(DailyEdition, target).article_ids)
        articles = [session.get(ArticleVariant, article_id) for article_id in original_ids]
        assert sum(article.exam_track == "high_school" for article in articles) == 2
        assert sum(article.exam_track is None for article in articles) == 3
        assert all(article.exam_track != "cet4" for article in articles)
        edition = session.get(DailyEdition, target)
        assert edition.coverage["tracks"] == {"general": 3, "high_school": 2}
        for article in session.scalars(select(ArticleVariant)):
            article.review_status = "rejected"

    with service.database.session() as session:
        edition_articles = [session.get(ArticleVariant, article_id) for article_id in original_ids]
        assert any(article.exam_track == "high_school" and article.cefr == "B1" for article in edition_articles)
    high_feed = service.daily_feed({"level": "B1", "topics": ["文化"], "track": "high_school"}, "high-school-b1")
    assert high_feed["primary"]["examTrack"] == "high_school"
    assert high_feed["primary"]["paragraphs"]
    assert not high_feed.get("fallback")

    assert service.pipeline.publish_today(target) == 0
    with service.database.session() as session:
        edition = session.get(DailyEdition, target)
        assert edition.article_ids == original_ids

    feed = service.daily_feed({"level": "B1", "topics": ["文化"]}, "local-user")
    assert feed["primary"]["paragraphs"]
    assert feed["editionDate"] == target.isoformat()


def test_exam_sources_stay_active_after_pipeline_reload(tmp_path):
    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'exam-source-reload.db'}",
        editorial_provider_order="",
    )
    service = ContentService(settings)
    store = ExamContentStore(service.database)
    store.import_passage(valid_passage())
    with service.database.session() as session:
        source = session.scalar(select(SourcePolicyRecord).where(SourcePolicyRecord.id.like("exam-source-%")))
        assert source.status == "active"
        source.status = "retired"

    service.pipeline.initialize()

    with service.database.session() as session:
        source = session.scalar(select(SourcePolicyRecord).where(SourcePolicyRecord.id.like("exam-source-%")))
        assert source.status == "active"
        assert source.crawl_allowed is False
