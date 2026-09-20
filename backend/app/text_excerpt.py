from __future__ import annotations

import html
import re

GUTENBERG_SKIP = re.compile(
    r"^\s*(pro(?:duced|ject gutenberg)|the project gutenberg|end of (the )?project|"
    r"start of (the )?project|this ebook|contents|chapter list|illustration|"
    r"transcriber|copyright|all rights reserved)",
    re.IGNORECASE,
)
NAV_SKIP = re.compile(
    r"today.?s apod|archive submissions|index search calendar|"
    r"download high-resolution|scientific visualization studio|"
    r"share this|follow us on|privacy policy|terms of use|"
    r"\bapod science apod\b",
    re.IGNORECASE,
)
LOW_QUALITY_TITLE = re.compile(
    r"^\s*APOD\b|invites media|media advisory|\bphoto release\b|\bnotice to media\b",
    re.IGNORECASE,
)


def clean_text(value: object) -> str:
    if value is None:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def paragraphs_from_article_html(raw: str) -> list[str]:
    text = raw or ""
    article = re.search(r"<article\b[^>]*>(.*?)</article>", text, flags=re.IGNORECASE | re.DOTALL)
    main = re.search(r"<main\b[^>]*>(.*?)</main>", text, flags=re.IGNORECASE | re.DOTALL)
    chunk = (article or main).group(1) if (article or main) else text
    chunk = re.sub(
        r"<(script|style|nav|footer|header|aside|form|noscript)\b[^>]*>.*?</\1>",
        " ",
        chunk,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return paragraphs_from_html(chunk)


def paragraphs_from_html(raw: str) -> list[str]:
    text = html.unescape(raw or "")
    chunks = re.split(r"</(?:p|div|h[1-6]|br)>|<br\s*/?>|\n\s*\n", text, flags=re.IGNORECASE)
    paragraphs = [clean_text(chunk) for chunk in chunks]
    return [item for item in paragraphs if _usable_paragraph(item)]


def paragraphs_from_cjk_text(raw: str, *, min_chars: int = 120, max_chars: int = 1400) -> list[str]:
    text = (raw or "").replace("\r\n", "\n")
    chunks = re.split(r"\n\s*\n|(?<=[。！？])\s+", text)
    chosen: list[str] = []
    total = 0
    for chunk in chunks:
        cleaned = clean_text(chunk)
        count = len(re.findall(r"[\u3400-\u9fff]", cleaned))
        if count < 12:
            continue
        chosen.append(cleaned)
        total += count
        if total >= max_chars and len(chosen) >= 3:
            break
    if total < min_chars or len(chosen) < 3:
        return []
    return chosen


def paragraphs_from_plain_text(raw: str) -> list[str]:
    text = (raw or "").replace("\r\n", "\n").replace("\r", "\n")
    chunks = re.split(r"\n\s*\n", text)
    paragraphs = [clean_text(chunk) for chunk in chunks]
    return [item for item in paragraphs if _usable_paragraph(item)]


def _usable_paragraph(text: str) -> bool:
    if not text or GUTENBERG_SKIP.search(text) or NAV_SKIP.search(text):
        return False
    words = re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", text)
    if len(words) < 8:
        return False
    letters = re.findall(r"[A-Za-z]", text)
    return len(letters) >= 40


def word_count(paragraphs: list[str]) -> int:
    return len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", " ".join(paragraphs)))


def cjk_char_count(text: str) -> int:
    return len(re.findall(r"[\u3400-\u9fff]", text or ""))


def drop_title_duplicate(paragraphs: list[str], title: str) -> list[str]:
    normalized_title = re.sub(r"\s+", " ", title or "").strip().lower()
    if not normalized_title:
        return paragraphs
    cleaned = []
    for paragraph in paragraphs:
        compact = re.sub(r"\s+", " ", paragraph).strip().lower().strip(" '\"“”‘’.")
        if compact == normalized_title or compact.startswith(f"{normalized_title} "):
            continue
        cleaned.append(paragraph)
    return cleaned or paragraphs


def is_low_quality_source(title: str, url: str = "", paragraphs: list[str] | None = None) -> bool:
    if LOW_QUALITY_TITLE.search(title or ""):
        return True
    lowered = (url or "").lower()
    if "apod.nasa.gov" in lowered or "/apod/" in lowered:
        return True
    for paragraph in (paragraphs or [])[:2]:
        if NAV_SKIP.search(paragraph):
            return True
    return False


def select_reading_excerpt(
    paragraphs: list[str],
    *,
    min_words: int = 180,
    max_words: int = 720,
) -> list[str]:
    chosen: list[str] = []
    total = 0
    for paragraph in paragraphs:
        next_count = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", paragraph))
        if chosen and total + next_count > max_words:
            break
        chosen.append(paragraph)
        total += next_count
        if total >= max_words and len(chosen) >= 3:
            break
    if word_count(chosen) < min_words or len(chosen) < 3:
        return []
    last = chosen[-1].rstrip()
    if not re.search(r"[.!?][\"']?$", last):
        chosen[-1] = last if last.endswith((".", "!", "?")) else f"{last}."
    return chosen
