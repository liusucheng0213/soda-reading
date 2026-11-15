# Model Center & Cost Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不增加账号、云服务或新运行时依赖的前提下，让翻译、内容审核和每日文章共用本机模型配置，并提供持久缓存、独立任务统计、真实/估算 token 记录和统一付费预算。

**Architecture:** 扩展 FastAPI 现有 `provider_config`，共享提供方定义，TranslationGateway 与 EditorialGateway 按任务读取顺序。新增一个本机 SQLite `model_center.db` 统一保存预算预留、调用用量和翻译缓存；浏览器只负责展示和编辑，不接触完整密钥。AI 内容审核属于后续内容阶段，本阶段只落地其路由配置，不新增虚假审核流程。

**Tech Stack:** Python 3.11、FastAPI、SQLite（标准库 sqlite3）、httpx、pytest；React 19、Vite 6、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`（第 6 节）

## Global Constraints

- 本地个人模式；不新增数据库服务、云同步或第三方运行时依赖。
- `translation`、`content_moderation`、`daily_article` 三个任务独立排序；爬取本身不配置模型。
- 默认 `paid_provider_enabled=False`、每日预算 0、`paid_fallback_mode="never"`；任何任务不得绕过既有开关、单次上限和每日预算。
- 密钥只写入本机 `provider_overrides.json`，接口仅返回掩码；用量事件不保存正文、提示词、响应全文或凭据。
- 缓存键包含任务、规范化输入、内容哈希和提示词版本；改变模型或排序不让既有高质量缓存全部失效。
- 失败仅短缓存；本地词典回退不写长期云缓存；重复请求继续合并。
- 用量区分供应商报告 token 与本地估算 token，费用始终是保守估算，不冒充供应商账单。
- 审核路由可以先配置；本阶段不声称已经实现 AI 审核或每日文章读者入口。
- 未经用户明确要求不提交；本阶段完成后是否推送由用户决定。

## Review Focus

- **任务 A 使用任务 B 的模型或预算：** 每个任务必须读取自己的顺序，但共用每日预算；由 Task 1、Task 2 测试锁定。
- **后端重启：** 成功翻译、用量和预算预留不能无故消失；由 Task 2、Task 3 的重开数据库测试锁定。
- **供应商不报 token、重试或返回错误：** 必须区分估算值，失败不得记录伪造成本；由 Task 4 测试锁定。
- **自定义模型与付费模型：** 自定义 OpenAI 兼容线路必须能用于生成，默认付费线路仍不得调用；由 Task 1、Task 4 测试锁定。
- **清缓存与密钥安全：** 清理只影响翻译缓存，不删除配置或学习数据，响应不包含密钥；由 Task 3、Task 5 测试锁定。

---

### Task 1: 共享提供方注册表与任务路由

**Files:**
- Modify: `backend/app/provider_config.py`
- Modify: `backend/app/translation.py`
- Modify: `backend/app/content_editorial.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_model_center.py`

**Interfaces:**
- Produces: `TASK_ROUTE_IDS = ("translation", "content_moderation", "daily_article")`。
- Produces: 共享 `Provider` dataclass 和 `provider_definitions(settings, overrides=None) -> dict[str, Provider]`。
- Produces: `task_provider_order(task, settings, overrides=None) -> list[str]`；缺失配置时分别回退到当前翻译/编辑默认顺序。
- Changes: `load_overrides()` 返回 `order/providers/routes`；`public_config()` 返回三个任务的 `routes`，`order` 继续表示翻译顺序。
- Changes: TranslationGateway 读取 `translation`，EditorialGateway 读取 `daily_article`，两者使用同一份自定义接口定义。

- [x] **Step 1: 写独立路由、自定义接口和密钥掩码失败测试**

```python
def test_tasks_have_independent_routes_and_custom_provider_is_shared(tmp_path, monkeypatch):
    payload = {
        "order": ["zhipu"],
        "routes": {"translation": ["zhipu"], "content_moderation": ["modelscope"], "daily_article": ["custom-lab"]},
        "providers": [{"id": "custom-lab", "kind": "openai", "baseUrl": "https://lab.invalid/v1", "model": "lab-model", "apiKey": "fake-test-key"}],
    }
    save_overrides(payload)
    assert task_provider_order("translation", settings) == ["zhipu"]
    assert task_provider_order("daily_article", settings) == ["custom-lab"]
    assert provider_definitions(settings)["custom-lab"].model == "lab-model"
    assert "fake-test-key" not in json.dumps(public_config())
```

另测非法任务、重复提供方和未知提供方 ID 被拒绝，以及默认零预算仍排除可能计费的自定义线路。

- [x] **Step 2: 运行新测试确认缺少接口**

Run: `PYTHONPATH=. python -m pytest tests/test_model_center.py -q`（在 `backend/`）
Expected: FAIL，任务路由和共享注册表不存在。

- [x] **Step 3: 实现共享注册表并接入两个网关**

把 `Provider` 移到 `provider_config.py` 并复用；TranslationGateway 保留 `load_overrides` 的现有测试 monkeypatch 点。EditorialGateway 仅使用 `kind="openai"` 的生成线路。保存配置后同时重建翻译与内容生成网关；`content_moderation` 仅保存配置，不新增调用。

- [x] **Step 4: 运行后端回归**

Run: `PYTHONPATH=. python -m pytest tests/test_model_center.py tests/test_api.py tests/test_content_pipeline.py -q`
Expected: PASS，既有动态排序、付费阻断和生成行为不变。

- [x] **Step 5: 在用户明确要求后提交共享路由变更**

### Task 2: 本机统一预算预留与用量存储

**Files:**
- Create: `backend/app/model_center.py`
- Modify: `backend/app/translation.py`
- Modify: `backend/app/content_editorial.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_model_center.py`
- Modify: `backend/tests/test_content_pipeline.py`（仅调整预算断言）

**Interfaces:**
- Produces: `ModelCenterStore(path=":memory:")`；生产路径由 `MODEL_CENTER_PATH` 指定，默认 `backend/data/model_center.db`。
- Produces: `reserve(task, provider, estimate_cny, daily_budget_cny, per_request_max_cny)`，超额抛出 `BudgetExceeded`；`release(task, provider, estimate_cny)` 释放失败预留。
- Produces: `record_usage(task, provider, model, success, input_tokens, output_tokens, tokens_reported, estimated_cny=0)`。
- Produces: `reserved_today_cny()`、`usage_summary()`；日期使用 `Asia/Shanghai`。
- Changes: 两个网关接受可选共享 `store`；未传时使用各自内存存储，避免测试接触真实文件。

- [x] **Step 1: 写重开持久化、任务共享预算和失败释放测试**

```python
@pytest.mark.asyncio
async def test_shared_budget_survives_reopen_and_releases_failure(tmp_path):
    store = ModelCenterStore(tmp_path / "center.db")
    await store.reserve("translation", "deepseek", 0.4, 1.0, 0.5)
    await store.reserve("daily_article", "deepseek", 0.4, 1.0, 0.5)
    with pytest.raises(BudgetExceeded):
        await store.reserve("content_moderation", "deepseek", 0.3, 1.0, 0.5)
    await store.release("translation", "deepseek", 0.4)
    reopened = ModelCenterStore(tmp_path / "center.db")
    assert await reopened.reserved_today_cny() == pytest.approx(0.4)
```

另测用量重开后仍按任务汇总，预留包含任务和提供方以便排查，但不保存正文或密钥。

- [x] **Step 2: 运行存储测试确认失败**

Run: `PYTHONPATH=. python -m pytest tests/test_model_center.py -q`
Expected: FAIL，`model_center.py` 尚不存在。

- [x] **Step 3: 实现 SQLite 预算与用量，并替换两份内存预算**

使用 asyncio 锁保护本机写入，预留表按自然日累计；成功保留估算费用，失败释放。`main.py` 创建一个共享 store 注入翻译和内容生成，保存配置后沿用同一 store。

- [x] **Step 4: 运行后端预算回归**

Run: `PYTHONPATH=. python -m pytest tests/test_model_center.py tests/test_content_pipeline.py -q`
Expected: PASS，包括 cheapApi 也消耗预算、零预算调用为零。

- [x] **Step 5: 在用户明确要求后提交统一存储变更**

### Task 3: 可重启复用的翻译缓存与清理接口

**Files:**
- Modify: `backend/app/model_center.py`
- Modify: `backend/app/translation.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_model_center.py`

**Interfaces:**
- Produces: `cache_get(key) -> dict | None`、`cache_set(key, value, ttl_seconds)`、`cache_clear() -> int`、`cache_entries() -> int`。
- Changes: 翻译缓存键不再包含整条 `_route_signature`；保留任务、规范化输入、内容哈希和 `PROMPT_VERSION`。
- Produces: `DELETE /admin/translation/cache`，同时清空本实例内存和 SQLite；不影响失败短缓存或配置。
- Changes: `overview()["cache"]` 增加 `diskHits` 与 `diskEntries`。

- [x] **Step 1: 写重开命中、模型变更复用、过期和清理测试**

```python
@pytest.mark.asyncio
async def test_translation_cache_survives_reopen_and_route_change(tmp_path, monkeypatch):
    first = TranslationGateway(settings_with_zhipu, store=ModelCenterStore(tmp_path / "center.db"))
    first._call_provider = fake_zhipu_result
    await first.translate("word", {"word": "bank", "sentence": "We sat on the river bank."})
    second = TranslationGateway(settings_with_deepseek, store=ModelCenterStore(tmp_path / "center.db"))
    second._call_provider = forbidden_cloud_call
    cached = await second.translate("word", {"word": "bank", "sentence": "We sat on the river bank."})
    assert cached["cacheLayer"] == "memory"
    assert forbidden_cloud_call.calls == 0
```

另起存储级测试覆盖 TTL=0、清空返回条数、清空后其他表记录仍在。

- [x] **Step 2: 运行缓存测试确认失败**

Run: `PYTHONPATH=. python -m pytest tests/test_model_center.py -q`
Expected: FAIL，持久缓存接口不存在，模型排序仍影响缓存键。

- [x] **Step 3: 实现磁盘层与清理端点**

内存未命中后读取 SQLite；写回内存供后续快速命中。云结果写两层，本地词典结果继续不写；负缓存只留内存。清理端点返回清理数量与最新 overview。

- [x] **Step 4: 运行缓存与翻译回归**

Run: `PYTHONPATH=. python -m pytest tests/test_model_center.py tests/test_api.py -q`
Expected: PASS，包括并发合并、本地回退不长期缓存和响应无密钥。

- [x] **Step 5: 在用户明确要求后提交持久缓存变更**

### Task 4: 实际/估算 token 与任务用量汇总

**Files:**
- Modify: `backend/app/model_center.py`
- Modify: `backend/app/translation.py`
- Modify: `backend/app/content_editorial.py`
- Modify: `backend/tests/test_model_center.py`
- Modify: `backend/tests/test_api.py`

**Interfaces:**
- Changes: OpenAI 兼容响应的 `usage.prompt_tokens/completion_tokens` 转为内部 `_usage`，在验证结果前移除，不暴露给阅读端正文。
- Changes: `usage_summary()` 按任务返回 `attempts/successes/failures/inputTokens/outputTokens/estimatedInputTokens/estimatedOutputTokens/estimatedCny`。
- Changes: `overview()` 增加 `tasks`，缓存与 `costGuard` 保持原字段。

- [x] **Step 1: 写供应商报告 token、无报告估算和失败不计伪造成本测试**

```python
@pytest.mark.asyncio
async def test_usage_distinguishes_reported_and_estimated_tokens():
    gateway = TranslationGateway(Settings(zhipu_api_key="test", translation_provider_order="zhipu"))
    gateway._call_provider = fake_result_with_usage(24, 7)
    await gateway.translate("word", {"word": "bank", "sentence": "We sat on the river bank."})
    usage = gateway.overview()["tasks"]["translation"]
    assert usage["inputTokens"] == 24
    assert usage["outputTokens"] == 7
    assert usage["successes"] == 1
```

另测无 `usage` 时只增加 `estimatedInputTokens/estimatedOutputTokens`，调用失败只增加 failures 和零输出成本，编辑生成也写入 `daily_article` 汇总。

- [x] **Step 2: 运行用量测试确认失败**

Run: `PYTHONPATH=. python -m pytest tests/test_model_center.py -q`
Expected: FAIL，任务用量和 token 字段不存在。

- [x] **Step 3: 接入调用记录**

成功时记录供应商报告值；无报告时按请求/响应字符数保守估算并单列。翻译使用 `translation`，本阶段现有编辑生成统一记为 `daily_article`；不虚构 `content_moderation` 调用。

- [x] **Step 4: 运行完整后端回归**

Run: `PYTHONPATH=. python -m pytest -q`
Expected: PASS，响应格式不变，预算与缓存仍有效。

- [x] **Step 5: 在用户明确要求后提交用量记录变更**

### Task 5: 模型中心管理界面

**Files:**
- Modify: `src/AdminApp.jsx`
- Modify: `src/lib/api.js`
- Modify: `src/styles.css`
- Create: `src/screens/ModelTaskRoutes.jsx`
- Create: `src/screens/ModelUsageSummary.jsx`
- Create: `src/lib/model-center.test.js`

**Interfaces:**
- Consumes: `providerConfig.routes`、`translationOverview.tasks/cache/costGuard`。
- Produces: `ModelTaskRoutes({ routes, onChange })` 与 `ModelUsageSummary({ overview, onRefresh })` 展示组件。
- Produces: `deleteTranslationCache()` API；原生 `<dialog>` 确认清理，取消不改变缓存。

- [x] **Step 1: 写三任务编辑、统计展示与清理确认失败测试**

静态渲染三个任务及各自顺序、实际/估算 token、成功/失败和缓存层；用 jsdom 验证取消不调用删除，确认才调用，调用后刷新 overview。

- [x] **Step 2: 运行界面测试确认失败**

Run: `npm test -- src/lib/model-center.test.js`
Expected: FAIL，任务路由和统计组件不存在。

- [x] **Step 3: 实现克制的管理界面与 API**

保留现有提供方编辑和掩码输入；用三个独立顺序输入替代单一全局顺序。显示付费总开关与共享预算，不把统计写成供应商账单。清理使用原生 dialog 和按钮焦点。

- [x] **Step 4: 运行前端回归与构建**

Run: `npm test && npm run build:web && npm run build:admin`
Expected: PASS，管理端产物断言成功。

- [x] **Step 5: 在用户明确要求后提交管理界面变更**

### Task 6: 真实服务验收与文档同步

**Files:**
- Modify: `docs/translation-provider-setup.md`
- Modify: `docs/project-overview.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`

- [x] **Step 1: 运行全部标准检查**

Run: `cd backend && PYTHONPATH=. python -m pytest -q`；`npm test && npm run build:web && npm run build:admin`
Expected: 全部 PASS。

- [x] **Step 2: 用隔离文件启动真实 API 和管理端**

使用临时 `PROVIDER_OVERRIDES_PATH`、`MODEL_CENTER_PATH` 和 `DATABASE_URL`，不读取或修改真实密钥。验证三任务保存、密钥掩码、生成网关刷新、缓存清理、零付费调用和统计展示；预置一条合成缓存验证清理前后数量。

- [x] **Step 3: 检查桌面/手机与真实阅读回归**

在桌面和约 390px 管理视口验证任务编辑与清理 dialog；普通阅读点词和本地复习不依赖模型中心。失败或没有密钥时界面诚实显示，不触发真实云调用。

- [x] **Step 4: 更新文档与最终工作区**

记录任务路由、持久缓存、实际/估算 token、统一预算和清理入口；第二阶段按验证结果勾选，更新日志写明未实现 AI 审核和每日文章入口。`git status --short` 只保留预期源码、测试和文档，无临时数据库、日志、截图或凭据。

- [x] **Step 5: 完成独立审查并处理重要问题**

审查任务串线、预算竞态、重启缓存、密钥泄漏和清理误伤；重要问题先 RED→GREEN，再跑完整检查。未经用户明确要求不提交或推送。
