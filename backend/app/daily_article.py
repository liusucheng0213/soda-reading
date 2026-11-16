from __future__ import annotations

from .content_editorial import LEVEL_TARGETS


def daily_article_word_range(level: str, length: str) -> tuple[int, int]:
    if level not in LEVEL_TARGETS or length not in {"short", "medium", "long"}:
        raise ValueError("Unsupported daily article level or length")
    minimum, maximum, _ = LEVEL_TARGETS[level]
    step = max(10, round(((maximum - minimum) / 3) / 10) * 10)
    lower = minimum + step
    upper = minimum + step * 2
    ranges = {
        "short": (minimum, lower),
        "medium": (lower, upper),
        "long": (upper, maximum),
    }
    return ranges[length]
