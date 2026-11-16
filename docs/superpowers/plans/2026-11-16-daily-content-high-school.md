# Daily Content Expansion and High-School Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展现有每日内容管道，增加可追溯来源、规则优先且成本受控的审核、可观察的拒绝原因，并让经过核验的高中原创阅读进入每日推荐，同时保证来源或模型失效时仍有稳定正文可读。

**Architecture:** 沿用 FastAPI、SQLAlchemy/SQLite、现有 `ContentPipeline` 与 `ExamContentStore`。确定性规则先拒绝明显不合格内容，仅把达到质量底线但需要语义判断的少量候选交给 `content_moderation` 路由；结果持久化在候选元数据中。高中内容复用阶段三的内容包、证据校验和幂等导入，但从独立目录进入每日池，CET4/CET6/考研仍留在备考书架。前端只增加今日页的「日常 / 高中」轻量切换和管理端指标，不改变阅读器视觉基准。

**Tech Stack:** Python 3.11、FastAPI、Pydantic 2、SQLAlchemy 2、SQLite、pytest；React 19、Vite 6、Vitest、jsdom；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`（第 6、7.1、7.3、7.4、9 节及阶段 4 验收）

## Global Constraints

- 默认 `PAID_PROVIDER_ENABLED=false`、`DAILY_PAID_BUDGET_CNY=0`；AI 审核复用 `content_moderation` 路由与共享 `ModelCenterStore`，不得绕过付费总开关、每日预算或单次上限。
- AI 只接收标题、来源、主题、风险标记和最长 1200 字符摘要，不发送完整正文；每次运行最多审核 6 个边界候选，不做无限重试，不记录提示词或响应全文。
- 严重、批评或有争议不等于低质量；明确仇恨、露骨内容、危险指导、虚假保证和标题党才进入拒绝或边界审核。规则不得声称能判断所有事实真伪。
- 低置信、证据不足、来源不可靠或模型不可用的边界候选不得自动发布，也不新增人工复核队列。已发布 `DailyEdition` 不得因新来源失败或候选不足而被空版本覆盖。
- 新增来源只保存许可允许的文字；第三方图片、标识和明确受版权保护的材料不复制。抓取权限与全文权限继续分别记录。
- `examTrack` 与 CEFR 独立。高中内容必须标 `original / 原创模拟`，逐题核对答案、中文解析与原文证据，不冒充真题。答题状态仍不持久化。
- 日常模式允许普通文章和高中文章进入同一每日池；高中模式只从高中实时池选择，缺少对应 CEFR 时可降级到同 CEFR 普通备用文，并诚实标记 `fallback/standby`，不能打开无正文卡片。
- 不改变生词记录键、FSRS、章节键、本地备份或模型密钥存储；不新增账号、云服务、定时后台生成、功能卡片网格或游戏化。
- 未经用户明确要求不提交或推送；所有完成标记必须来自实际测试和端到端验收。

## Review Focus

- 付费或自定义线路在零预算下被调用；提示词、正文或完整密钥进入日志。
- 严肃议题被情绪关键词误杀；AI 低置信或不可用仍自动发布。
- 新增来源越权保存全文；单一来源失败覆盖既有今日版本。
- CET4/CET6/考研混入今日推荐，高中内容未进入版本或无法按 CEFR 阅读。
- 切换轨道后前端本地排序又把另一轨道或无正文文章提到首位。
- 重复率、主题覆盖、审核拒绝原因只存在数据库而管理端不可见。

## Pre-flight Interface Decisions

- Task 1 产出规则结果与运行指标，Task 2 消费这些结果并只处理 `review` 候选；AI 审核不得重新打开确定性拒绝。
- Task 3 复用阶段三 `ExamPassage` 与 `ExamContentStore.import_passages()`；Task 4 只消费序列化后的 `examTrack/contentOrigin/questions/provenance`，不新建第二套高中模型。
- Task 3 的每日版本包含 `coverage.tracks`，Task 5 管理端直接读取该字段和 Task 2 的 `moderationStats`。
- Task 4 的 `preferences.track` 取 `daily | high_school`，后端、前端本地排序和首页切换共用同一约定。

---

### Task 1: 确定性审核规则、候选排序与运行指标

**Files:**
- Create: `backend/app/content_moderation.py`
- Modify: `backend/app/content_pipeline.py`
- Modify: `backend/app/content_store.py`
- Modify: `backend/tests/test_content_pipeline.py`
- Create: `backend/tests/test_content_moderation.py`

**Interfaces:**
- Produces: `RuleModerationDecision(blocking_reasons, review_reasons)` 与 `moderate_candidate_rules(candidate) -> RuleModerationDecision`。
- Produces: `PipelineRun.moderation_stats` JSON；运行序列化新增 `moderationStats`（含 `reasons/ruleRejected/aiAccepted/aiRejected/aiSkipped`）和 `duplicateRate`。
- `ContentCandidate.status` 保持 `accepted/review/rejected`；确定性拒绝不得进入后续 AI。

- [x] **Step 1: 写规则、排序和指标失败测试**

覆盖：严肃批评文章不因负面词被拒绝；明确仇恨/露骨/危险指导和标题党返回稳定原因码；健康保证类表述进入边界审核；质量低于 65 仍直接拒绝，达 75 且无风险的候选直接通过，中间或风险候选进入 `review`。验证重复率、拒绝原因聚簇和旧 SQLite 添加 `moderation_stats` 后仍可读取。

- [x] **Step 2: 运行测试确认缺少规则与字段**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_content_moderation.py tests/test_content_pipeline.py -k "moderation or duplicate_rate" -q`
Expected: FAIL，`app.content_moderation` 或 `moderationStats` 不存在。

- [x] **Step 3: 实现规则优先审核和持久指标**

在 `_filter_and_store()` 中先应用基础校验和确定性规则，再按质量分与风险决定 `accepted/review/rejected`。保存结构化原因到候选 `metadata_json.moderation`，保留现有 `rejection_reason` 兼容输出。对本次运行候选统计拒绝原因，不改写既有今日版本。`ContentDatabase.initialize()` 幂等添加 `pipeline_runs.moderation_stats`，`serialize_run()` 计算 `duplicateCount / max(1, fetchedCount)`。

- [x] **Step 4: 回归候选过滤、主题覆盖和既有考试导入**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_content_moderation.py tests/test_content_pipeline.py tests/test_exam_content.py -q`
Expected: 全部 PASS；CET 内容包与普通文章契约不变。

### Task 2: 有界、可缓存、失败关闭的 AI 边界审核

**Files:**
- Modify: `backend/app/content_moderation.py`
- Modify: `backend/app/content_pipeline.py`
- Modify: `backend/app/settings.py`
- Modify: `backend/tests/test_content_moderation.py`
- Modify: `backend/tests/test_api.py`

**Interfaces:**
- Produces: `ContentModerationGateway.moderate(candidate) -> dict`，返回 `decision/confidence/reasons/provider/model/inputHash`；不返回请求或响应正文。
- `ContentPipeline._moderate_review_candidates(run_id, limit=6)` 只处理本 run 的 `review` 候选，返回新增通过 ID 与统计。
- 候选 `metadata_json.moderation` 持久化 `promptVersion/inputHash/decision/confidence/provider/model/reasons`，相同哈希不重复云端调用。

- [x] **Step 1: 写零预算、上下文上限、缓存与失败关闭测试**

用假提供方确认 `content_moderation` 路由被使用，输入不含完整段落且摘要不超过 1200 字符；零预算时付费线路调用次数为 0。低置信、拒绝、超时、无效 JSON 和无可用模型均不能通过候选；相同内容哈希第二次不增加调用。每次运行第 7 个边界候选不调用模型且不发布。

- [x] **Step 2: 运行测试确认网关不存在**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_content_moderation.py -q`
Expected: FAIL，`ContentModerationGateway` 不存在或预算断言失败。

- [x] **Step 3: 实现共享路由、预算预留与结构化结果校验**

复用 `provider_definitions/task_provider_order`、`ModelCenterStore.reserve/release/record_usage`。只请求严格 JSON：`decision=approve|reject`、`confidence=0..1`、有界原因数组。只有 `approve && confidence>=0.85` 才通过；其他结果均不自动发布。失败释放预算并记录安全用量元数据，不保存提示词、正文、完整响应或密钥。

- [x] **Step 4: 接入管道并保留降级**

`run()` 在聚簇前审核本 run 的 `review` 候选；AI 通过才加入 accepted IDs，其余标为 rejected 并记录原因。无模型、超过每轮 6 个或付费被阻断时记录 `aiSkipped/moderation_unavailable`，已有 accepted 候选和既有 DailyEdition 继续工作。`generate=False` 的纯发现运行不主动消耗 AI，边界候选保留不发布状态并记 `aiSkipped`。

- [x] **Step 5: 运行后端回归**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_content_moderation.py tests/test_content_pipeline.py tests/test_model_center.py tests/test_api.py -q`
Expected: 全部 PASS，无真实模型调用。

### Task 3: 新合规来源、高中内容包与每日版本保留

**Files:**
- Modify: `backend/app/content_sources.py`
- Modify: `backend/app/content_pipeline.py`
- Modify: `backend/app/exam_store.py`
- Modify: `backend/scripts/import_exam_content.py`
- Create: `backend/content/high-school/*.json`（4 篇）
- Modify: `backend/tests/test_content_pipeline.py`
- Modify: `backend/tests/test_exam_content.py`

**Interfaces:**
- 新增 `nsf-rss` 与 `energy-gov-rss`，均为 A 级 RSS；只保存文字段落，全文权限不向上提升。
- 高中包使用 `examTrack=high_school`、`contentOrigin=original`，位于 `backend/content/high-school/`；导入命令为 `PYTHONPATH=. python scripts/import_exam_content.py content/high-school`。
- `ExamContentStore.list()` 默认仍只返回 CET4/CET6/考研；高中通过每日 feed 暴露。
- `DailyEdition.coverage.tracks` 至少包含 `general/high_school`。

- [x] **Step 1: 写来源、轨道隔离、版本保留失败测试**

用合成 RSS 验证两个新适配器只产生许可文字候选。导入 CET 与高中各一篇后，默认备考目录不含高中，`publish_today()` 不含 CET 但能选择高中。构造既有今日版本并让本轮合格文章不足，确认返回 0 且旧 article IDs 原样保留；`daily_feed()` 仍能返回既有正文。

- [x] **Step 2: 运行测试确认来源与高中每日行为缺失**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_content_pipeline.py tests/test_exam_content.py -k "nsf or energy or high_school or edition" -q`
Expected: FAIL，新来源、高中覆盖或版本保留断言不成立。

- [x] **Step 3: 注册已核验来源并实现轨道感知发布**

注册 `https://www.nsf.gov/rss/rss_www_news.xml` 与 `https://www.energy.gov/rss/articles.xml`，在策略注释/文档记录 NSF 与 DOE 官方文字复用依据及第三方材料排除规则。把 NSF 加入小规模快速来源集。发布查询明确排除 CET4/CET6/考研，在总上限内优先保留至多 2 篇不同主题的高中文章，并记录 track coverage；候选不足时不覆盖已有版本。

- [x] **Step 4: 编写并逐篇核验 4 个高中原创内容包**

覆盖校园/成长、故事、科普、文化；A2/B1/B2 均有正文，每篇 4 道四选一题，题型覆盖细节、推理、猜词或主旨。逐题核对答案、中文解析和完整证据句，填写 2026-11-16 的来源与答案核验时间；全部标原创模拟，不写真题年份或外部来源。

- [x] **Step 5: 验证真实内容包、幂等和版本**

Run: 使用临时数据库连续执行两次高中导入，再运行 `cd backend && PYTHONPATH=. python -m pytest tests/test_exam_content.py tests/test_content_pipeline.py -q`。
Expected: 首次新增 4 篇、第二次新增 0；16 题证据校验通过，CET 不进入每日版本，高中文章有正文且测试全绿。

### Task 4: 今日页高中切换、CEFR 排序与稳定降级

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/content.py`
- Modify: `src/lib/profile.js`
- Modify: `src/lib/profile.test.js`
- Modify: `src/lib/api.js`
- Modify: `src/lib/api.test.js`
- Modify: `src/lib/feed.js`
- Modify: `src/lib/feed.test.js`
- Modify: `src/App.jsx`

**Interfaces:**
- `GET /feed/daily?track=daily|high_school`；默认 `daily` 允许普通与高中，`high_school` 实时池只选高中，其他考试轨道始终排除。
- 本地 profile 新增 `track: "daily" | "high_school"`，默认 `daily`，持久化于现有浏览器账户桶。
- `displayFeed()` 保持 CEFR 精确匹配优先，再匹配所选 track；高中降级普通文时 `standby=true`，不制造高中标签或空正文。

- [x] **Step 1: 写 API、profile 与本地排序失败测试**

后端构造普通、高中和 CET 同 CEFR 文章，确认 daily 不混入 CET，high_school 只返回高中实时内容，高中不足时返回有正文的普通 fallback。前端确认 query 携带 track、profile 只接受合法值；同 CEFR 时高中优先，缺少高中精确 CEFR 时普通同级文章降级且 `standby=true`，CEFR 切换仍改变主文。

- [x] **Step 2: 运行新测试确认失败**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_api.py -k "high_school or daily_feed" -q`；根目录 `npm test -- src/lib/feed.test.js src/lib/profile.test.js src/lib/api.test.js`。
Expected: FAIL，track 参数、排序或 profile 字段尚未实现。

- [x] **Step 3: 实现后端轨道过滤与推荐缓存隔离**

`Preferences` 和路由接收 track，并纳入现有 preference hash。推荐读取和生成始终排除 CET4/CET6/考研；高中模式进一步只选高中。缓存键包含 track，切换轨道不复用旧推荐。没有足够高中正文时使用现有完整备用库，不返回空卡片。

- [x] **Step 4: 实现今日页轻量切换与诚实标签**

在 CEFR 控件附近增加「日常 / 高中」切换，复用 `updateProfile` 的请求竞态保护。文章元信息在高中文章上显示「高中」，普通文章仍显示主题；标题在高中降级时明确为「高中备用导读」。不添加功能卡片、 pipeline 说明、渐变或正文后来源 footer。

- [x] **Step 5: 运行前端与后端联合回归**

Run: `npm test -- src/lib/feed.test.js src/lib/profile.test.js src/lib/api.test.js src/lib/exams.test.js src/lib/exam-practice.test.js && cd backend && PYTHONPATH=. python -m pytest tests/test_api.py tests/test_exam_content.py -q`
Expected: 全部 PASS；CEFR 精确匹配、考试书架和答题解析行为不回归。

### Task 5: 管理端可观测性、文档与真实验收

**Files:**
- Modify: `src/AdminApp.jsx`
- Modify: `src/styles.css`
- Modify: `src/lib/api.test.js`（仅在需要锁定管理端契约时）
- Modify: `docs/content-pipeline-operations.md`
- Modify: `docs/project-overview.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`

**Interfaces:**
- 管理端展示 `duplicateRate`、`topicCoverage`、`coverage.tracks` 和 `moderationStats.reasons`；无运行时显示 0/尚未运行，不请求新的人工复核队列接口。

- [x] **Step 1: 补管理端数据契约与降级测试**

确认运行响应提供重复率、六主题计数、轨道计数和拒绝原因；候选行展示具体 `rejectionReason`，没有结果时保持现有空态。纯前端映射如抽出函数则先写 Vitest 失败测试再实现。

- [x] **Step 2: 实现克制的管理端指标与原因显示**

在现有采集面板显示重复率、高中/普通发布数和按次数排序的审核拒绝原因；候选状态使用「通过 / 边界 / 淘汰」，不增加闲置人工复核队列。保持 390px 不横向溢出、键盘焦点清晰和 `prefers-reduced-motion`。

- [x] **Step 3: 运行标准检查**

Run: `cd backend && PYTHONPATH=. python -m pytest -q`；根目录 `npm test && npm run build:web && npm run build:admin`。
Expected: 全部 PASS，记录实际测试数量。

- [x] **Step 4: 用隔离数据库走通真实服务与浏览器路径**

使用临时 `DATABASE_URL/MODEL_CENTER_PATH/PROVIDER_OVERRIDES_PATH` 和空密钥启动 FastAPI/Vite，导入 6 篇考试与 4 篇高中内容。用合成候选走通采集、规则拒绝和零 AI 降级，确认既有今日版本保留。桌面和 390px 验证：日常/高中切换、CEFR 切换、打开高中正文、答题与解析、收藏并复习本文生词、刷新保留轨道和阅读位置；管理端查看重复率、主题/轨道覆盖与拒绝原因。全程不调用真实付费模型。

- [x] **Step 5: 检查真实新增来源与故障降级**

分别访问 NSF/DOE RSS 做小规模真实抓取，记录成功或具体网络失败；模拟单一来源异常，确认其他来源和既有今日内容仍可用。测试产生的临时数据库、日志和截图在验收后清理，不使用个人密钥。

- [x] **Step 6: 按证据更新文档、路线图与阶段五评估**

记录新来源及版权依据、AI 审核上下文/次数/预算边界、高中导入命令、track API、降级行为与真实测试数量。仅在全部验收通过后勾选阶段 4。单独列出阶段 5 已具备的路由/预算/来源/缓存能力和仍缺的读者确认入口、兴趣/形式/篇幅参数、证据装配、按日生成锁与每日缓存，不提前勾选阶段 5。
