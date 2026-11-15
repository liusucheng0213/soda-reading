from __future__ import annotations

from datetime import datetime
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


EXAM_TRACKS = ("high_school", "cet4", "cet6", "postgraduate")
CONTENT_ORIGINS = ("official_exam", "licensed_exam", "adapted", "original")
CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")


class ExamModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExamProvenance(ExamModel):
    source_label: str = Field(alias="sourceLabel", min_length=1, max_length=200)
    source_id: str = Field(alias="sourceId", min_length=1, max_length=200)
    source_url: str | None = Field(default=None, alias="sourceUrl")
    retrieved_at: datetime | None = Field(default=None, alias="retrievedAt")
    license: str = Field(default="", max_length=300)
    usage_basis: str = Field(default="", alias="usageBasis", max_length=1000)

    @field_validator("source_url")
    @classmethod
    def https_source(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith("https://"):
            raise ValueError("sourceUrl 必须使用 HTTPS")
        return value


class ExamQuestion(ExamModel):
    id: str = Field(min_length=1, max_length=60)
    prompt: str = Field(min_length=1)
    options: list[str] = Field(min_length=4, max_length=4)
    answer: Literal["A", "B", "C", "D"]
    explanation_zh: str = Field(alias="explanationZh", min_length=1)
    evidence_paragraph: int = Field(alias="evidenceParagraph", ge=0)
    evidence_sentence: str = Field(alias="evidenceSentence", min_length=1)

    @field_validator("options")
    @classmethod
    def distinct_nonempty_options(cls, options: list[str]) -> list[str]:
        normalized = [option.strip() for option in options]
        if any(not option for option in normalized):
            raise ValueError("选项不能为空")
        if len({option.casefold() for option in normalized}) != 4:
            raise ValueError("选项不能重复")
        return normalized


class ExamPassage(ExamModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{2,63}$")
    title: str = Field(min_length=1)
    author: str = Field(min_length=1)
    topic: str = Field(min_length=1)
    cefr: Literal["A1", "A2", "B1", "B2", "C1", "C2"]
    published_at: datetime = Field(alias="publishedAt")
    intro_zh: str = Field(alias="introZh", min_length=1)
    paragraphs: list[str] = Field(min_length=2)
    exam_track: Literal["high_school", "cet4", "cet6", "postgraduate"] = Field(alias="examTrack")
    content_origin: Literal["official_exam", "licensed_exam", "adapted", "original"] = Field(alias="contentOrigin")
    year: int | None = None
    session: str = ""
    region: str = ""
    paper: str = ""
    questions: list[ExamQuestion] = Field(min_length=4, max_length=4)
    provenance: ExamProvenance
    source_reviewed_at: datetime = Field(alias="sourceReviewedAt")
    answers_reviewed_at: datetime = Field(alias="answersReviewedAt")

    @field_validator("paragraphs")
    @classmethod
    def nonempty_paragraphs(cls, paragraphs: list[str]) -> list[str]:
        if any(not paragraph.strip() for paragraph in paragraphs):
            raise ValueError("正文段落不能为空")
        return paragraphs

    @field_validator("source_reviewed_at", "answers_reviewed_at")
    @classmethod
    def reviewed_at_has_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("核验时间必须包含时区")
        return value

    @model_validator(mode="after")
    def validate_provenance(self):
        external = self.content_origin != "original"
        if external:
            provenance = self.provenance
            if not provenance.source_url or not provenance.retrieved_at:
                raise ValueError("外部内容必须有 HTTPS sourceUrl 和 retrievedAt")
            if not provenance.license.strip() or not provenance.usage_basis.strip():
                raise ValueError("外部内容必须有许可与使用依据")
        if self.content_origin in {"official_exam", "licensed_exam"}:
            if self.year is None or not 1986 <= self.year <= datetime.now().year + 1:
                raise ValueError("真题或授权试卷必须有合理年份")
        return self


def validate_exam_passage(payload: dict) -> ExamPassage:
    passage = ExamPassage.model_validate(payload)
    question_ids = set()
    for question in passage.questions:
        if question.id in question_ids:
            raise ValueError(f"题目 {question.id} 重复")
        question_ids.add(question.id)
        if question.evidence_paragraph >= len(passage.paragraphs):
            raise ValueError(f"题目 {question.id} 的 evidenceParagraph 不存在")
        paragraph = passage.paragraphs[question.evidence_paragraph]
        sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", paragraph) if part.strip()]
        if question.evidence_sentence not in sentences:
            raise ValueError(f"题目 {question.id} 的 evidenceSentence 不是对应段落的完整原句")
    return passage
