from copy import deepcopy

import pytest
from pydantic import ValidationError
from sqlalchemy import inspect, select, text

from app.content import ContentService
from app.content_store import ArticleVariant, ContentDatabase
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
