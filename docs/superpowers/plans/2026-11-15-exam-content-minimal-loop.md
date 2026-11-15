# Exam Content Minimal Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CET4、CET6 和考研建立可追溯的小批量阅读内容，并让读者完成“筛选文章 → 阅读 → 答题看解析与原文依据 → 收藏并复习本文生词”的最小闭环。

**Architecture:** 复用现有 `ArticleVariant`、阅读器和本地生词系统，新增经过 Pydantic 校验的考试内容包及幂等导入器，不另建账号、云服务或自动爬题管道。后端提供只读考试目录，前端在书架中按考试轨道筛选；答题状态仅用于当前阅读会话，第一阶段不建设成绩分析或题感推荐。

**Tech Stack:** Python 3.11、FastAPI、Pydantic 2、SQLAlchemy 2、SQLite、pytest；React 19、Vite 6、Vitest、jsdom。

**Spec:** `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`（第 7.1–7.2 节、阶段 3 验收）

## Global Constraints

- `examTrack` 与 CEFR 完全分离；支持 `high_school / cet4 / cet6 / postgraduate`，本阶段只为后三者导入内容，高中内容留到阶段 4。
- `contentOrigin` 仅允许 `official_exam / licensed_exam / adapted / original`；只有来源和使用依据均核验通过的 `official_exam / licensed_exam` 才能显示“真题”，其余分别显示“改编”或“原创模拟”。
- 公开网页可见不等于可以再发布；无法确认使用依据时不批量收录，也不通过改标签凑数量。
- 首批目标为 6 篇：每个轨道各 1 篇科普和 1 篇故事，每篇 4 道四选一仔细阅读题；实际真题数量由溯源核验结果决定，不能为了完成数量而降低门槛。
- 答案、解析和原文依据由内容编辑逐题核验；确定性代码验证结构和原文定位，不声称能自动判断语义答案是否正确，不为本阶段内容生成答案调用 AI。
- 保持现有阅读器、行间译义、章节键和“文章＋词＋原句”生词记录键；不增加游戏化、成绩单、云同步或答题排行榜。
- 阅读端不增加版权/流水线讲解或正文后来源免责 footer；管理文档记录完整溯源和导入方法。
- 不新增运行时依赖；未经用户明确要求不提交或推送。第二阶段“重复提供方 ID 静默覆盖”的收尾修复先于本计划实施。

## Review Focus

- **改编/原创被误标为真题：** Task 1 限制来源枚举，Task 2 检查入库来源，Task 4 锁定界面标签。
- **证据句不在正文、选项重复或答案越界：** Task 1 写拒绝测试，导入必须全部失败而非跳过错误后继续发布。
- **重复导入或同 ID 正文被覆盖：** Task 2 验证幂等，并拒绝同 ID 不同正文，避免既有生词回到错误原文。
- **旧内容库或普通文章没有考试字段：** Task 1 验证数据库升级和普通文章 `null` 默认值，Task 3 验证普通今日源不混入考试文章。
- **考试接口离线：** Task 3 验证书架和既有阅读仍可用，只显示诚实的备考内容加载状态。
- **答题后收藏的生词无法回到原句：** Task 5 用真实考试文章验证收藏、本文复习、原文定位和章节键。

---

### Task 1: 考试内容契约、确定性校验与存储字段

**Files:**
- Create: `backend/app/exam_content.py`
- Modify: `backend/app/content_store.py:129-160,220-229`
- Modify: `backend/app/content.py:377-404`
- Create: `backend/tests/test_exam_content.py`

**Interfaces:**
- Produces: `EXAM_TRACKS = ("high_school", "cet4", "cet6", "postgraduate")` 和 `CONTENT_ORIGINS = ("official_exam", "licensed_exam", "adapted", "original")`。
- Produces: `ExamProvenance`、`ExamQuestion`、`ExamPassage` Pydantic 模型，以及 `validate_exam_passage(payload: dict) -> ExamPassage`。
- Produces: `ArticleVariant.exam_track/content_origin/exam_metadata/questions/provenance`；普通文章的 API 字段为 `examTrack=None`、`contentOrigin=None`、`questions=[]`。

- [x] **Step 1: 写有效样本和结构/溯源失败测试**

用一个 `original` 科普样本声明：四级轨道、B2、两个以上段落、4 道题，每题 `prompt/options/answer/explanationZh/evidenceParagraph/evidenceSentence`。测试以下规则：
- 合法样本通过并保留稳定 `id`；四个轨道和四个来源枚举受控。
- `options` 必须恰好 4 个非空且去重，`answer` 只能是 `A/B/C/D`，题号在本文唯一。
- `evidenceParagraph` 必须存在，`evidenceSentence` 必须是对应段落的精确子串；改一个字符即拒绝。
- 外部来源必须有 HTTPS `sourceUrl`、`retrievedAt`、`license`、`usageBasis`、`sourceLabel/sourceId` 和人工核验时间；`official_exam/licensed_exam` 还必须有合理 `year`。
- 所有内容模型使用 `ConfigDict(extra="forbid")`；`adapted/original` 不得携带 `officialExam=true` 一类冲突声明，未知字段也直接拒绝。

- [x] **Step 2: 运行测试确认缺少考试契约**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_exam_content.py -q`
Expected: FAIL，`app.exam_content` 不存在。

- [x] **Step 3: 实现内容模型与跨字段校验**

`ExamPassage` 至少包含 `id/title/author/topic/cefr/publishedAt/introZh/paragraphs/examTrack/contentOrigin/year/session/region/paper/questions/provenance/sourceReviewedAt/answersReviewedAt`。`validate_exam_passage()` 先进行 Pydantic 形状验证，再检查每题证据定位、正文非空和人工核验日期；错误信息指出具体题号，不返回正文或密钥。

- [x] **Step 4: 扩展文章存储与普通文章序列化**

在 `ArticleVariant` 增加 `exam_track`（可空、索引）、`content_origin`（可空）、`exam_metadata`（JSON）、`questions`（JSON）、`provenance`（JSON）。`ContentDatabase.initialize()` 对新库使用 `create_all`，对既有 SQLite 仅幂等添加这 5 个缺失列；`_article_dict()` 输出 camelCase 字段，并将 `year/session/region/paper` 归入 `exam` 元数据。

- [x] **Step 5: 验证新库、既有库和回归**

新增测试：先建立不含考试列的 SQLite，再初始化并确认普通文章仍可读取、考试列为空。运行 `PYTHONPATH=. python -m pytest tests/test_exam_content.py tests/test_content_pipeline.py tests/test_api.py -q`，全部通过后才继续。

- [x] **Step 6: 仅在用户明确要求后提交本任务**

### Task 2: 首批核验内容包与幂等导入器

**Files:**
- Create: `backend/app/exam_store.py`
- Create: `backend/scripts/import_exam_content.py`
- Create: `backend/content/exams/*.json`（6 个内容文件）
- Modify: `backend/tests/test_exam_content.py`

**Interfaces:**
- Consumes: `validate_exam_passage(payload)` 与 Task 1 的文章字段。
- Produces: `ExamContentStore(database).import_passage(payload: dict) -> dict`、`.list(track: str | None = None) -> list[dict]`。
- Produces: CLI `PYTHONPATH=. python scripts/import_exam_content.py content/exams`；任一文件无效时退出非零且不写入任何一篇。

- [ ] **Step 1: 写导入事务、幂等与正文保护测试**

测试空库导入后 `list("cet4")` 只返回该轨道；重复导入同一文件总数不变；同 ID 不同段落抛出 `ValueError`；同一批次第二个文件含错误证据句时，第一篇也不能留在数据库。只有序列化后的 `review_status="approved"` 且通过全部校验的内容进入目录。

- [ ] **Step 2: 运行导入测试确认失败**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_exam_content.py -k "import or list" -q`
Expected: FAIL，`ExamContentStore` 不存在。

- [ ] **Step 3: 实现事务导入与目录查询**

`ExamContentStore` 使用 `ContentDatabase.session()` 的同一事务，复用现有 `SourcePolicyRecord/ContentCandidate/StoryCluster` 外键关系，并为每篇内容使用稳定来源、候选、聚簇和文章 ID。保存正文哈希、CEFR、词数、`max(2, ceil(word_count / 180))` 阅读分钟、来源数组、题目和完整溯源；重复导入同一 `body_hash` 直接返回既有文章，同 ID 不同哈希必须拒绝。`list()` 按轨道和 `review_status="approved"` 查询，并复用 `ContentService._article_dict()` 的输出契约。

CLI 先读取并验证目录内全部 JSON，再用一个事务导入；输出仅含 ID、轨道、来源类型和数量，不调用模型或网络。

- [ ] **Step 4: 编写并逐篇核验 6 个内容文件**

每个轨道准备科普、故事各 1 篇，每篇 4 题，题材和语言难度与轨道相符。逐题由内容编辑对照原文确认答案、解析和证据句，并填写 `answersReviewedAt`；逐篇检查来源 URL、获取时间、许可/使用依据并填写 `sourceReviewedAt`。来源或使用依据不确定的外部文本不得入库，可改为明确标注的原创模拟，但不得保留“真题”表述。

- [ ] **Step 5: 验证真实内容包与导入器**

Run: 在临时目录准备隔离数据库，执行 `cd backend && DATABASE_URL=sqlite:///<临时绝对路径>/exams.db PYTHONPATH=. python scripts/import_exam_content.py content/exams` 两次；结束后删除临时数据库。
Expected: 首次导入 6 篇，第二次新增 0 篇；按三轨道各返回 2 篇，24 题证据校验全部通过，完整后端测试通过。

- [ ] **Step 6: 仅在用户明确要求后提交本任务**

### Task 3: 只读考试 API 与书架轨道筛选

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_api.py`
- Modify: `src/lib/api.js`
- Modify: `src/lib/api.test.js`
- Modify: `src/App.jsx:119-170,296-365,505-555`
- Create: `src/lib/exams.js`
- Create: `src/lib/exams.test.js`

**Interfaces:**
- Consumes: `ExamContentStore.list(track)`。
- Produces: `GET /exams/catalog?track=cet4|cet6|postgraduate`，返回 `{"items": [article...]}`；不传轨道返回全部三轨道，非法轨道返回 422。
- Produces: `getExamCatalog()`、`EXAM_TRACK_LABELS`、`examOriginLabel(article)` 和 `filterExamArticles(items, track)`。

- [ ] **Step 1: 写 API 隔离与标签测试**

后端测试导入 CET4 与考研各一篇，确认按轨道过滤、普通 `/feed/daily` 不含考试文章、普通文章考试字段为空。前端测试确认 `official_exam/licensed_exam` 显示“真题”，`adapted/original` 分别显示“改编/原创模拟”，轨道标签为“CET4 / CET6 / 考研”，筛选不改变 CEFR。

- [ ] **Step 2: 运行新测试确认失败**

Run: `cd backend && PYTHONPATH=. python -m pytest tests/test_api.py -k exam -q`；根目录 `npm test -- src/lib/exams.test.js src/lib/api.test.js`。
Expected: FAIL，目录端点和前端助手不存在。

- [ ] **Step 3: 实现只读目录和前端数据加载**

在 `main.py` 注入共享的 `ExamContentStore` 并添加免登录只读端点。`getExamCatalog()` 不注入伪造的离线考试文章；失败时由 `App` 保存 `examCatalog=[]` 和可显示的错误状态，同时保留普通 feed、馆藏、生词和导入书。

- [ ] **Step 4: 接入书架与原文返回目录**

`App` 将考试文章加入 resume、Library 和 Vocabulary 使用的全部 `catalog` 计算。`LibraryScreen` 在现有“馆藏”中增加“全部 / CET4 / CET6 / 考研”筛选和克制的文章行，展示轨道、CEFR、来源类型与标题；不使用功能卡片网格。加载失败只在该区域显示“备考内容暂时无法加载，其他馆藏仍可使用”。

- [ ] **Step 5: 验证目录、离线和普通阅读回归**

Run: `npm test -- src/lib/exams.test.js src/lib/api.test.js src/lib/feed.test.js && cd backend && PYTHONPATH=. python -m pytest tests/test_api.py tests/test_exam_content.py -q`。
Expected: 全部 PASS；后端离线不阻断普通书架，考试筛选无空白正文入口。

- [ ] **Step 6: 仅在用户明确要求后提交本任务**

### Task 4: 阅读后的答题、解析与原文依据

**Files:**
- Create: `src/screens/ExamPractice.jsx`
- Create: `src/lib/exam-practice.test.js`
- Modify: `src/screens/ReaderScreen.jsx:1465-1475`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `article.questions[]`（每题含 `id/prompt/options/answer/explanationZh/evidenceParagraph/evidenceSentence`）和 Task 3 的来源标签。
- Produces: `ExamPractice({ article })`；答案和揭示状态只保存在组件内，不写入 FSRS、阅读进度或个人备份。

- [ ] **Step 1: 写隐藏答案、错误/正确作答和重答测试**

用 jsdom 渲染两道合成题，断言初始 DOM 不含“正确答案”、解析和原文依据区（四个选项本身正常显示）；未选答案时“核对答案”禁用。选择错误项并核对后显示“回答错误”、正确项、中文解析和精确原文依据；改选其他项后解析重新隐藏，再次核对显示“回答正确”。普通文章不渲染答题区。

- [ ] **Step 2: 运行组件测试确认失败**

Run: `npm test -- src/lib/exam-practice.test.js`
Expected: FAIL，`ExamPractice` 不存在。

- [ ] **Step 3: 实现原生可访问的答题组件**

每题使用独立 `<fieldset>`、`<legend>` 和同名 radio 组，选项 label 可点击并支持方向键。只有读者主动点击“核对答案”才揭示结果；结果区用适度的 `role="status"`，原文依据直接引用英文句子，不另开 dialog、popover 或底部 sheet。组件不显示分数、积分或掌握建议。

- [ ] **Step 4: 将答题区接入正文末尾**

在最后一章正文与 `ReadingCompletion` 之间，仅对 `examTrack` 非空且题目存在的文章渲染 `ExamPractice`。在现有文章元信息处显示考试轨道、CEFR 和 `examOriginLabel()`；不添加正文后版权 footer。样式沿用纸面、 hairline 和现有按钮密度，并覆盖 390px、清晰焦点及 `prefers-reduced-motion`。

- [ ] **Step 5: 运行前端回归与构建**

Run: `npm test && npm run build:web && npm run build:admin`
Expected: 全部 PASS，普通阅读器和管理端产物断言均通过。

- [ ] **Step 6: 仅在用户明确要求后提交本任务**

### Task 5: 学习闭环、真实服务验收与文档同步

**Files:**
- Modify: `src/lib/vocabulary.test.js`（仅补充考试 ID/原句回归所需测试）
- Modify: `docs/project-overview.md`
- Modify: `docs/content-pipeline-operations.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md:226-231,251-261`

**Interfaces:**
- Consumes: 既有 `vocabularyItemId(article.id, word, sentence)`、`contentId/chapterId` 和“复习本文”过滤逻辑；不改变其签名。

- [ ] **Step 1: 补学习闭环回归测试**

用考试文章 ID 和证据句创建生词，验证重复收藏不建重卡、本文复习只选该文章、恢复原句仍携带相同 `contentId/chapterId`。若现有测试已完整覆盖通用逻辑，不为考试复制同义测试，改为在端到端验收中锁定。

- [ ] **Step 2: 运行标准检查**

Run: `cd backend && PYTHONPATH=. python -m pytest -q`；根目录 `npm test && npm run build:web && npm run build:admin`。
Expected: 全部 PASS；记录实际数量，不沿用阶段 2 的数字。

- [ ] **Step 3: 用隔离数据库走通真实路径**

使用临时 `DATABASE_URL/MODEL_CENTER_PATH/PROVIDER_OVERRIDES_PATH` 和空密钥启动 FastAPI 与 Vite，导入真实 6 篇内容包。桌面与 390px 分别验证：书架三轨道筛选 → 打开有正文文章 → 点词并收藏 → 答错、改答、核对解析与原文依据 → 复习本文生词 → 返回正确原句。刷新后阅读位置与生词保留；答题会话按本阶段约定可重置。全程不调用真实付费模型。

- [ ] **Step 4: 检查来源、降级与最终工作区**

逐篇打开来源记录并核对内容文件中的答案/证据，确认所有界面标签与 `contentOrigin` 一致；停掉考试 API 后普通今日、书架和既有生词仍可用。清理临时数据库、日志和截图，检查 `git status --short` 只含预期源码、内容、测试和文档。

- [ ] **Step 5: 按证据更新文档与路线图**

文档记录考试目录 API、内容包格式、导入命令、人工答案/来源核验要求及答题状态不持久化的边界。仅在实际测试和端到端验收全部通过后勾选路线图阶段 3，并在更新日志写明真实篇数、来源类型、测试数量和未实现的高中/每日 AI 范围。

- [ ] **Step 6: 完成审查，且仅在用户明确要求后提交**

重点复核来源误标、事务部分导入、正文覆盖、普通 feed 串入、答案提前泄露和生词原文错配；重要问题先补失败测试再修复，最后重跑完整检查。
