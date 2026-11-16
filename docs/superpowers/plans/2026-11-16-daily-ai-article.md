# Daily Personalized AI Article Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让读者在今日页明确确认兴趣、形式、篇幅和 CEFR 后，每天最多生成一篇有可靠证据、句译和词汇资产的英文文章；刷新、切换设置或并发点击不得重复调用模型，失败时普通今日阅读仍然可用。

**Architecture:** 复用 `EditorialGateway`、`daily_article` 路由、共享预算和 `ArticleVariant`。新增 `DailyArticleStore`，用 SQLite 中“本机读者＋Asia/Shanghai 日期”的唯一记录串行化确认请求、保存生成状态并关联生成文章；从已通过审核的候选中确定性筛选 3–4 个不同可靠来源并装配有界证据。前端新增轻量 `DailyAiPanel`，只在主动点击确认后 POST，页面加载仅 GET 当日状态。生成文章复用阅读、收藏、复习和原文返回，不进入考试轨道。

**Tech Stack:** Python 3.11、FastAPI、Pydantic 2、SQLAlchemy 2、SQLite、pytest；React 19、Vite 6、Vitest、jsdom；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`（第 8–10 节、阶段 5–6）

**Execution status:** 任务 1–4 已完成；任务 5 的自动化、真实假模型、离线、审查和文档已完成。桌面、手机、键盘与目录回归已做，但真实设备听读和 reduced-motion 复核仍未完成，因此不将阶段 6 标为全部完成。

## Global Constraints

- 默认 `PAID_PROVIDER_ENABLED=false`、`DAILY_PAID_BUDGET_CNY=0`；每日文章只能走 `daily_article` 路由和既有预算预留，不绕过付费总开关、单日预算或单次上限。
- 页面打开、CEFR/兴趣变化、刷新和 GET 状态均不得触发模型。只有读者明确点击“确认生成”才可 POST；同一天已存在 `generating/ready/failed` 记录时不再次调用模型。
- 使用 Asia/Shanghai 自然日和固定 `local-user`。同日参数变化只影响下一次可生成日；不提供“重新生成”按钮。
- 证据只来自 `accepted`、许可明确、来源启用且质量达标的候选；选择 3–4 个不同来源，去重并限制每个摘要长度。证据不足、模型不可用、校验失败或超时均诚实降级，不伪造正文。
- 生成结果必须通过现有英文段落、词数、事实句证据绑定、逐句中文翻译和 15–25 个语境词汇校验。保存来源和事实绑定，但不保存完整提示词、模型响应全文或密钥到日志/导出。
- 生成文章标为 `content_mode="daily_ai"`、`contentOrigin="original"`，`examTrack=None`、`questions=[]`；不冒充真题，不增加正文后来源免责 footer。
- 普通今日内容、高中轨道、备考书架和本地文档在每日 AI 离线或失败时保持可用。答题状态、FSRS、备份 schema 和生词记录键不变。
- 界面保持纸面、hairline 和既有密度；不用功能卡片网格、渐变、气泡、重阴影、游戏化或装饰动效。支持键盘、390px 触控和 `prefers-reduced-motion`。

## Review Focus

- 双击、两个并发请求或刷新导致同一天重复付费调用。
- GET、参数变更或失败后的自动重试绕过读者确认。
- 同日不同参数绕过缓存；后端重启后丢失当日文章或生成锁。
- 同一来源凑够 3 条、候选未通过审核、全文权限不足或证据超长仍进入模型。
- 零预算下付费线路被调用；模型返回无证据数字、缺句译或缺词汇仍发布。
- 成功文章没有进入阅读/收藏/复习目录，或失败遮罩普通今日正文。
- 加载时自动生成、答案式“重新生成”、手机横向溢出和键盘无法完成设置。

---

### Task 1: 请求契约、篇幅范围与受控生成参数

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/content_editorial.py`
- Create: `backend/app/daily_article.py`
- Create: `backend/tests/test_daily_article.py`
- Modify: `backend/tests/test_model_center.py`

**Interfaces:**
- `DailyArticleRequest`：`interest` 为科技/文化/商业/自然/健康/历史，`form` 为 `story/science/explainer`，`length` 为 `short/medium/long`，`cefr` 为 A1–C2；`extra="forbid"`。
- `daily_article_word_range(level, length) -> tuple[int, int]`：把现有 CEFR 词数区间拆成三个有界范围，非法值抛出 `ValueError`。
- `EditorialGateway.generate(..., form="explainer", word_range=None)`：旧调用保持原词数范围；每日自定义调用传入形式与范围。

- [ ] **Step 1: 写契约、范围和提示词失败测试**
  验证未知字段/兴趣/形式/篇幅被拒绝；六个 CEFR 的三种范围递增且落在 `LEVEL_TARGETS` 内；故事、科普和说明形式进入系统提示，custom range 同时进入用户参数和结果校验，超范围正文被拒绝。
- [ ] **Step 2: 运行测试确认缺少契约**
  Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_daily_article.py -q`
  Expected: FAIL，`daily_article` 模块或请求模型不存在。
- [ ] **Step 3: 实现请求模型、词数范围和向后兼容的生成参数**
  不复制生成器或预算逻辑；扩展 `_call/_validate` 的可选参数，保持既有管道 `generate(topic, level, evidence)` 行为不变。表单值只映射为受控写作指令，不拼接任意用户提示词。
- [ ] **Step 4: 回归生成器与模型中心**
  Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_daily_article.py tests/test_model_center.py tests/test_content_pipeline.py -q`
  Expected: 全部 PASS，既有用量和预算行为不变。
- [ ] **Step 5: 提交本任务**

### Task 2: 有界证据、持久每日锁与文章保存

**Files:**
- Modify: `backend/app/daily_article.py`
- Modify: `backend/app/content_store.py`
- Modify: `backend/tests/test_daily_article.py`

**Interfaces:**
- `DailyArticleStore(database, gateway, clock=None)`：`.today(user_id="local-user") -> dict`、`.generate(request, user_id="local-user") -> dict`、`.evidence_for(interest) -> list[dict]`。
- `DailyArticleRecord`：`(user_id, generation_date)` 联合主键；`status=generating/ready/failed`、`request_json/article_id/error/created_at/updated_at`。
- 当日响应：`{date,status,request,article,error}`；article 复用 `ContentService._article_dict()`，空状态 article 为 `None`。

- [ ] **Step 1: 写证据筛选和旧库升级失败测试**
  构造许可/状态/质量/主题不同的候选，确认只返回 3–4 个不同合格来源，摘要有界且不带无权限段落；少于 3 个来源时返回空证据。先建无 `daily_article_records` 的旧 SQLite，再初始化确认新表可读且原表不变。
- [ ] **Step 2: 写当日缓存、并发与失败关闭测试**
  用假 gateway 统计调用：同日 GET 为 0；两个并发 generate 只有 1 次；ready 后不同参数和 Store 重建仍为同一文章且不再调用；证据不足、模型失败和取消均不保存伪造文章，失败结果同日复用。陈旧 `generating` 记录只转为安全失败，不自动重试。
- [ ] **Step 3: 运行测试确认存储不存在**
  Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_daily_article.py -q`
  Expected: FAIL，`DailyArticleStore/DailyArticleRecord` 不存在。
- [ ] **Step 4: 实现原子确认记录与有界证据装配**
  预留记录须在调用模型前提交；用异步锁和数据库唯一键共同防止并发双写。锁只负责本机确认/生成串行化，数据库记录负责重启恢复。跨进程看到 `generating` 时只返回状态，不启动第二次生成。超过现有生成总超时的陈旧锁标记 `GENERATION_INTERRUPTED`，不重新调用。
- [ ] **Step 5: 实现事务化文章与事实来源保存**
  生成文章、聚簇、`FactClaim` 和 ready 记录在同一事务落库；失败只写安全错误码。文章 ID 由读者和日期确定性生成，保存 request、3–4 个来源、CEFR、词数、句译、glossary 和事实绑定，`review_status="approved"`。禁止异常文本、密钥和完整提示词进入 error。
- [ ] **Step 6: 验证幂等、隔离和回归**
  Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_daily_article.py tests/test_exam_content.py tests/test_content_pipeline.py -q`
  Expected: 全部 PASS；同一临时数据库重建后仍返回当天同一文章。
- [ ] **Step 7: 提交本任务**

### Task 3: 只读状态/确认生成 API 与前端确认组件

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/tests/test_api.py`
- Modify: `src/lib/api.js`
- Modify: `src/lib/api.test.js`
- Create: `src/screens/DailyAiPanel.jsx`
- Create: `src/lib/daily-ai-panel.test.js`

**Interfaces:**
- `GET /daily-ai/today`：只返回状态，不生成。
- `POST /daily-ai/generate`：接收 `DailyArticleRequest`；返回同一当日契约。已有记录直接复用；`generating` 可用 202 返回，不新建任务。
- `getDailyAiToday()`、`generateDailyAi(payload, {signal})`；生成请求超时至少覆盖后端总超时。
- `DailyAiPanel({profile,state,onGenerate,onOpen})`：未生成时显示兴趣/形式/篇幅/CEFR 控件与确认按钮；ready 显示文章入口；failed 显示普通今日文章仍可用的降级说明。

- [ ] **Step 1: 写 API 无自动生成、参数和缓存测试**
  GET 不调用 gateway；合法 POST 才调用；非法参数 422；重复 POST 不增加调用；模型不可用返回安全 failed 状态而不是堆栈或伪造文章。
- [ ] **Step 2: 写组件确认、加载、成功和失败测试**
  初始渲染不调用 `onGenerate`；读者可修改四项设置并确认一次，pending 禁止重复点击；ready 只打开文章，不出现重新生成；failed 显示降级且不再自动提交。API mock 验证 POST body 和 GET 不携带生成参数。
- [ ] **Step 3: 运行新测试确认失败**
  Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_api.py -k daily_ai -q`；根目录 `npm test -- src/lib/daily-ai-panel.test.js src/lib/api.test.js`。
  Expected: FAIL，端点或组件不存在。
- [ ] **Step 4: 实现 API 与可访问组件**
  控件使用原生 `label/select/button`，状态用适度 `role="status"`；不用 dialog。前端只保存最近一次当日状态，不把文章复制进个人备份，不把失败自动转换为重复 POST。
- [ ] **Step 5: 运行 API 与前端回归**
  Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_api.py tests/test_daily_article.py -q`；根目录 `npm test -- src/lib/daily-ai-panel.test.js src/lib/api.test.js src/lib/feed.test.js`。
  Expected: 全部 PASS。
- [ ] **Step 6: 提交本任务**

### Task 4: 今日置顶、阅读学习闭环与响应式样式

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/styles.css`
- Modify: `src/lib/daily-ai-panel.test.js`
- Modify: `src/lib/reader-chapter.test.js`（仅通用闭环确有缺口时）

**Interfaces:**
- App 保存 `dailyAiState`；挂载只 GET 一次，ready/generating 变化不触发 feed 刷新或模型调用。
- 生成文章加入 resume、Library 和 Vocabulary 共用的 catalog；`DailyAiPanel.onOpen` 复用 `openArticle`。

- [ ] **Step 1: 写目录与状态边界测试**
  验证 ready 文章保留 `contentId/chapterId` 进入普通阅读目录，failed/empty 不注入空正文文章；切 CEFR 或 track 不替换已生成文章。已有通用测试覆盖时不复制同义测试。
- [ ] **Step 2: 接入今日页与全部目录计算**
  今日 AI 区位于普通 featured reading 之前；ready 展示“今日 AI 文章”、标题、导读、CEFR 与阅读入口。普通今日文章仍保留在下方。将文章加入 resume effect、主 catalog 和 Library 馆藏，确保收藏后复习与原文返回使用现有 ID。
- [ ] **Step 3: 添加克制的响应式样式**
  设置区采用行列和 hairline；390px 不横向溢出，触控目标至少 44px，桌面不形成卡片网格；焦点清晰，无新增装饰动画，沿用 reduced-motion 规则。
- [ ] **Step 4: 运行前端完整回归与构建**
  Run: `npm test && npm run build:web && npm run build:admin`
  Expected: 全部 PASS，普通阅读器与管理端产物断言通过。
- [ ] **Step 5: 提交本任务**

### Task 5: 真实服务验收、阶段 6 回归与文档同步

**Files:**
- Modify: `docs/project-overview.md`
- Modify: `docs/content-pipeline-operations.md`
- Modify: `docs/translation-provider-setup.md`（涉及每日路由说明时）
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`

- [ ] **Step 1: 运行标准检查**
  Run: `cd backend && PYTHONPATH=. python -m pytest -q`；根目录 `npm test && npm run build:web && npm run build:admin`。
  Expected: 全部 PASS；记录实际数量，不沿用前序阶段数字。
- [ ] **Step 2: 用隔离数据库和假模型走通真实 API**
  使用临时 `DATABASE_URL/MODEL_CENTER_PATH/PROVIDER_OVERRIDES_PATH`，准备 3 个合格来源和本地假 OpenAI 兼容响应，启动真实 FastAPI/Vite。桌面与 390px 分别验证：加载无生成 → 修改四项设置并确认 → 今日置顶阅读 → 点词收藏 → 句译 → 复习本文 → 返回原句；刷新和重复 POST 仍同一文章且假模型调用总数为 1。
- [ ] **Step 3: 验证失败、预算和重启降级**
  在零预算付费线路、少于 3 来源、无效模型 JSON 和后端重启场景下确认不重复收费、不发布空文章，普通今日/高中/备考仍可阅读。检查日志、API 错误和个人备份无完整密钥、提示词或模型响应全文。
- [ ] **Step 4: 完成阶段 6 桌面、手机、键盘、减弱动效与听读回归**
  验证 1440px 和 390px 的今日、书架、阅读、复习、模型中心；仅用键盘完成每日设置、阅读与复习；开启 reduced-motion；对生成文章验证播放/暂停、上一句/下一句、再读本句、从此句朗读、划出本句和 Space 控制。检查移动端目录 dialog 与返回焦点，不新增视觉改版。
- [ ] **Step 5: 检查最终工作区并按证据更新文档**
  记录 API、参数、证据/预算边界、每日锁和失败策略；仅在所有验收通过后勾选阶段 5–6，写明真实测试数量、假模型验收和任何未能验证的真实供应商能力。清理临时数据库、日志和截图，`git status --short` 只含预期文件。
- [ ] **Step 6: 完成整体审查并提交**
  重点复核重复生成、日期边界、陈旧锁、证据权限、零预算、提示词泄露、失败降级和学习闭环；重要问题先补失败测试再修复，最后重跑完整检查并提交。
