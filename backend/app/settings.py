from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    dev_sms_code: str = "246810"
    local_admin_password: str = ""
    admin_api_token: str = ""
    allowed_origins: str = "http://localhost:4173,http://127.0.0.1:4173"

    modelscope_access_token: str = ""
    modelscope_model: str = "Qwen/Qwen3.5-35B-A3B"
    zhipu_api_key: str = ""
    zhipu_model: str = "glm-4.7-flash"
    siliconflow_api_key: str = ""
    siliconflow_model: str = "Qwen/Qwen2.5-7B-Instruct"
    tencent_secret_id: str = ""
    tencent_secret_key: str = ""
    tencent_region: str = "ap-guangzhou"
    dashscope_api_key: str = ""
    dashscope_model: str = "qwen-mt-flash"
    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-chat"
    translation_provider_order: str = "deepseek"
    translation_provider_timeout_ms: int = 8000
    translation_total_timeout_ms: int = 12000
    redis_url: str = ""
    translation_cache_ttl_seconds: int = 2_592_000
    translation_failure_ttl_seconds: int = 8
    translation_memory_cache_entries: int = 5_000
    translation_dynamic_routing: bool = True
    tencent_free_quota_guarded: bool = False
    paid_fallback_mode: str = "never"
    paid_request_max_cny: float = 0.02
    database_url: str = "sqlite:///./data/soda_content.db"
    celery_broker_url: str = "redis://127.0.0.1:6379/0"
    celery_result_backend: str = "redis://127.0.0.1:6379/1"

    paid_provider_enabled: bool = False
    daily_paid_budget_cny: float = 0
    content_discovery_min: int = 500
    content_discovery_max: int = 2000
    content_target_clusters: int = 30
    content_timezone: str = "Asia/Shanghai"
    content_active_cefr_levels: str = "A2,B1,B2,C1"
    content_max_daily_variants: int = 12
    content_publish_offset_days: int = 0
    content_source_timeout_seconds: float = 25
    content_per_domain_concurrency: int = 2
    content_auto_publish: bool = True
    content_user_agent: str = "SodaReading/0.1 (English reading prototype; +https://github.com/soda-reading; soda-reading-bot@outlook.com)"
    content_contact_email: str = "soda-reading-bot@outlook.com"
    editorial_provider_order: str = "deepseek,zhipu,modelscope"
    editorial_provider_timeout_ms: int = 30000
    editorial_total_timeout_ms: int = 75000
    content_prefer_original: bool = True

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def provider_order(self) -> list[str]:
        return [provider.strip().lower() for provider in self.translation_provider_order.split(",") if provider.strip()]

    @property
    def editorial_order(self) -> list[str]:
        return [provider.strip().lower() for provider in self.editorial_provider_order.split(",") if provider.strip()]

    @property
    def configured_cefr_levels(self) -> list[str]:
        valid = {"A2", "B1", "B2", "C1"}
        levels = [
            level.strip().upper()
            for level in self.content_active_cefr_levels.split(",")
            if level.strip().upper() in valid
        ]
        return list(dict.fromkeys(levels)) or ["B1"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
