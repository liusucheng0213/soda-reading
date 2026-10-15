import importlib.util
from pathlib import Path

import pytest


def load_recorder():
    path = Path(__file__).resolve().parents[1] / "scripts" / "record_platform_usage.py"
    spec = importlib.util.spec_from_file_location("record_platform_usage", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recorder = load_recorder()


def test_non_postgres_usage_does_not_fail_the_job():
    assert recorder.record_usage("sqlite:///./data/soda_content.db", "github_action_minutes", 1.2, {}) == "skipped"
    assert recorder.record_usage("", "github_action_minutes", 1, {}) == "skipped"


def test_unknown_usage_type_is_rejected():
    with pytest.raises(ValueError):
        recorder.record_usage("postgresql://localhost/soda", "sms", 1, {})
