# Vocabulary Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不因重复标记增加额外云端调用的前提下，为现有阅读器补齐连续生词标记、两阶段主动回忆、分批 FSRS 复习、已掌握词库和可靠的新版本地备份。

**Architecture:** 保留浏览器 localStorage 中的单一生词集合，以 `learningState` 区分学习和掌握状态，不新增数据库。`@soda-reading/core` 继续负责 FSRS 与复习会话，React 只负责阅读/复习交互；所有操作复用现有译义、原句和缓存。

**Tech Stack:** React 19、Vite 6、Vitest、`ts-fsrs` 5.4.1、浏览器 localStorage / IndexedDB、现有 JSON 备份。

**Spec:** `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`

## Global Constraints

- 保持本地个人模式，不增加账号、云同步、数据库服务或新依赖。
- 未经用户明确要求，不执行 Git 提交；计划中的提交步骤只作为后续手动整理建议。
- 默认点词语境翻译保持不变；“生词标记”是可选模式，不把词译改成弹层。
- 每批默认 20 张并沿用用户设置，但每张卡继续独立 FSRS；已掌握卡不得到期。
- 本阶段不维护旧版记录或备份迁移分支；新生词显式保存 `learningState`，不得重复或改变原句定位。
- 忘记在当前批重排；撤销必须同时恢复队列、FSRS 和掌握状态。
- 备份只导出和接受 schemaVersion 2；凭据与完整密钥不得进入备份。
- 界面保持简约，不使用游戏化、装饰性动效或功能卡片网格。
- 单词和全文音频继续使用浏览器 Web Speech API，不增加云 TTS。

## Review Focus

- **掌握与撤销交错：** 掌握词不得再到期，撤销掌握必须恢复原卡和队列；由 Task 1、Task 2 的会话测试锁定。
- **同一词同一原句被连续标记：** 不得重复建卡或恢复无需恢复的卡；由 Task 4 的幂等测试和浏览器检查锁定。
- **翻译失败或请求被中止：** 不得保存空译义，也不能因旧请求完成而误标新词；由 Task 4 的状态检查和浏览器弱网/失败场景锁定。
- **非当前版本与恶意/损坏输入：** 应明确拒绝，新字段类型错误应拒绝，恢复失败应回滚；由 Task 5 的验证与回滚测试锁定。

---

### Task 1: 生词生命周期与独立到期选择

**Files:**
- Modify: `packages/core/src/review.js`
- Create: `packages/core/src/review.test.js`

**Interfaces:**
- Produces: `vocabularyState(item) -> "learning" | "mastered"`。
- Produces: `learningVocabulary(items)`、`masteredVocabulary(items)`，均返回新数组且不改原记录。
- Produces: `dueVocabulary(items, now = new Date())`，返回所有到期的学习卡，按到期时间升序且不截断。
- Produces: `setVocabularyLearningState(item, state, now = new Date())`；`mastered` 记录 ISO `masteredAt`，恢复 `learning` 时清除该时间并把 `card.due` 设为 `now`。
- Keeps: `dueCards(items, limit, now)` 的签名不变，但改为从 `dueVocabulary` 取当前批；`startReviewSession` 自动排除掌握卡。

- [x] **Step 1: 写生命周期和批次选择的失败测试**

```js
it("excludes mastered words from due cards", () => {
  const learning = { id: "learning", word: "shade", learningState: "learning", card: { due: "2026-11-10T00:00:00.000Z" } };
  const mastered = { ...learning, id: "done", learningState: "mastered" };
  expect(vocabularyState(learning)).toBe("learning");
  expect(dueVocabulary([learning, mastered], new Date("2026-11-11T00:00:00.000Z")).map((item) => item.id)).toEqual(["learning"]);
});

it("restores a mastered word to an immediately due learning card", () => {
  const restored = setVocabularyLearningState(
    { id: "done", learningState: "mastered", masteredAt: "2026-11-01T00:00:00.000Z", card: { due: "2027-01-01T00:00:00.000Z" } },
    "learning",
    new Date("2026-11-13T08:00:00+08:00"),
  );
  expect(restored.learningState).toBe("learning");
  expect(restored.masteredAt).toBeNull();
  expect(restored.card.due).toBe("2026-11-13T00:00:00.000Z");
});
```

- [x] **Step 2: 运行测试并确认因接口不存在而失败**

Run: `npm test -- packages/core/src/review.test.js`  
Expected: FAIL，所测导出尚不存在。

- [x] **Step 3: 实现生命周期与到期选择**

在 `packages/core/src/review.js` 增加上述纯函数；`dueCards` 保留现有 10–50 的批次限制，状态规范化不得改写输入。`setVocabularyLearningState` 使用现有 `cardFromRow` / `serializeCard`，不引入第二份掌握词存储。

- [x] **Step 4: 运行核心与既有复习测试**

Run: `npm test -- packages/core/src/review.test.js src/lib/review-session.test.js src/lib/study.test.js`  
Expected: PASS；既有复习与学习工具回归均通过。

- [x] **Step 5: 提交这一独立数据层变更**

```bash
git add packages/core/src/review.js packages/core/src/review.test.js
git commit -m "feat: add vocabulary learning lifecycle"
```

### Task 2: 两阶段回忆、掌握操作与完整撤销

**Files:**
- Modify: `packages/core/src/review.js`
- Modify: `src/screens/ReviewSession.jsx`
- Modify: `src/lib/review-session.test.js`
- Modify: `src/App.jsx` 中词汇复习结果处理函数。

**Interfaces:**
- Extends: `rateSessionCard(session, rating, now)` 返回完整 `beforeItem` 和 `afterItem`；不再保留冗余的 `before` / `after` 卡片字段。
- Produces: `masterSessionCard(session, now = new Date()) -> { session, item, beforeItem, afterItem }`，将当前词掌握、移出当前队列并记入同一份撤销历史。
- Changes: `undoReviewSession` 返回 `beforeItem`，使调用方能恢复整张卡及学习状态。
- Changes: `ReviewSession.onReview(item, rating, itemSnapshot)` 的第三个参数由“仅卡片”改为“完整词项”；`App.jsx` 用完整词项替换对应记录。

- [x] **Step 1: 写两阶段状态与撤销的失败测试**

```js
it("masters the current card and undoes the whole item", () => {
  const session = startReviewSession(words, 20, now);
  const mastered = masterSessionCard(session, now);
  expect(mastered.afterItem.learningState).toBe("mastered");
  expect(currentReviewItem(mastered.session).id).toBe("b");
  const undone = undoReviewSession(mastered.session);
  expect(undone.beforeItem.learningState).toBe("learning");
  expect(currentReviewItem(undone.session).id).toBe("a");
});

it("keeps the Chinese answer hidden during initial recall", () => {
  const baseProps = {
    items: words,
    reviewLimit: 20,
    onReview: () => {},
    onExit: () => {},
    onOpen: () => {},
    catalog: [],
  };
  const html = renderToStaticMarkup(React.createElement(ReviewSession, baseProps));
  expect(html).toContain("认识");
  expect(html).toContain("不认识");
  expect(html).not.toContain(">树荫<");
});
```

- [x] **Step 2: 运行测试并确认当前会话缺少新行为**

Run: `npm test -- src/lib/review-session.test.js packages/core/src/review.test.js`  
Expected: FAIL，掌握会话接口和两阶段文案尚不存在。

- [x] **Step 3: 实现会话快照和两阶段界面**

`ReviewSession` 使用 `recall / confirm / unknown` 三阶段：首屏不泄露译义；“认识”只揭示答案，FSRS 尚未评分；确认页提供“记错 / 困难 / 正确 / 轻松”，依次映射 Again / Hard / Good / Easy；“不认识”揭示答案后以 Again 重排。掌握按钮在答案揭示后可用，所有推进都通过 `afterItem` 写回。评分和掌握共用的每个 history entry 都保存操作前的完整 `beforeItem`，撤销时优先恢复它，而不是只恢复 `card`。

保留快捷键并明确提示：首屏 Space = 认识、1 = 不认识；确认页 1–4 = 记错/困难/正确/轻松；不认识答案页 Space 或 1 = 继续本轮；Ctrl/Cmd+Z 撤销最近一次评分或掌握。

- [x] **Step 4: 运行复习测试并检查旧路径**

Run: `npm test -- src/lib/review-session.test.js packages/core/src/review.test.js`  
Expected: PASS，包括 Again 重排、四档评分、原文返回、掌握及撤销。

- [x] **Step 5: 提交复习会话变更**

```bash
git add packages/core/src/review.js src/screens/ReviewSession.jsx src/lib/review-session.test.js src/App.jsx
git commit -m "feat: add two-stage vocabulary recall"
```

### Task 3: 分批学习与已掌握词库界面

**Files:**
- Modify: `src/screens/VocabularyScreen.jsx`
- Modify: `src/screens/ReviewSession.jsx`
- Modify: `src/lib/review-session.test.js`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `learningVocabulary`、`masteredVocabulary`、`dueVocabulary` 和 `setVocabularyLearningState`。
- Consumes: Task 2 的完整词项 `onReview` 写回。
- Produces: 词库视图 `learning / mastered`；学习页显示全部到期数和当前批大小，掌握页支持“恢复复习”。

- [x] **Step 1: 写词库视图和到期统计的失败测试**

```js
it("counts all due learning words without counting mastered words", () => {
  const card = { due: "2026-11-09T00:00:00.000Z" };
  const learningDueA = { id: "a", learningState: "learning", card };
  const learningDueB = { id: "b", learningState: "learning", card };
  const masteredDueC = { id: "c", learningState: "mastered", card };
  const items = [learningDueA, learningDueB, masteredDueC];
  expect(dueVocabulary(items, now).map((item) => item.id)).toEqual(["a", "b"]);
  expect(masteredVocabulary(items).map((item) => item.id)).toEqual(["c"]);
});
```

并为 `VocabularyScreen` 增加静态渲染断言：显示“待复习”“已掌握”入口、真实到期总数、当前批数量，以及掌握页的“恢复复习”。

- [x] **Step 2: 运行界面测试并确认失败**

Run: `npm test -- src/lib/review-session.test.js`  
Expected: FAIL，现有词库没有学习/掌握视图和完整到期统计。

- [x] **Step 3: 实现词库视图与下一批流程**

学习视图继续使用当前词列表和“原文”；掌握视图复用同一记录，恢复后立即回到到期池。当前批结束且仍有到期词时显示“复习下一批”，通过更新 `sessionId` 创建新会话，不把上一批的完成状态带入下一批。

- [x] **Step 4: 补充克制的视图样式并运行测试**

只增加必要的分段控件、状态文字和列表间距，保持当前字体、颜色和卡片密度。  
Run: `npm test -- src/lib/review-session.test.js src/lib/study.test.js`  
Expected: PASS。

- [x] **Step 5: 提交词库界面变更**

```bash
git add src/screens/VocabularyScreen.jsx src/screens/ReviewSession.jsx src/lib/review-session.test.js src/styles.css
git commit -m "feat: add batched review and mastered vocabulary"
```

### Task 4: 阅读器连续生词标记模式

**Files:**
- Create: `src/lib/vocabulary.js`
- Create: `src/lib/vocabulary.test.js`
- Modify: `src/screens/ReaderScreen.jsx` 的词请求、保存和工具栏路径。
- Modify: `src/styles.css`

**Interfaces:**
- Produces: `upsertVocabularyItem(items, candidate, now = new Date())`；使用现有 `isSameVocabularyItem` 判断同一 `contentId + normalized word + sentence`，学习卡重复标记时返回原数组，掌握卡被明确重标时恢复为 `learning`，否则追加带 FSRS 新卡的候选词项。
- Consumes: 现有 `translateWord`、`peekWordTranslation`、`vocabularyItemId` 和 Task 1 的状态接口。
- Keeps: 默认点词、短拖短语、行间注、句译和划线行为。

- [x] **Step 1: 写标记幂等与恢复的失败测试**

```js
it("does not duplicate the same contextual word", () => {
  const items = [candidate];
  expect(upsertVocabularyItem(items, candidate, now)).toBe(items);
});

it("restores rather than duplicates an explicitly re-marked mastered word", () => {
  const masteredCandidate = { ...candidate, learningState: "mastered", masteredAt: "2026-11-01T00:00:00.000Z" };
  const result = upsertVocabularyItem([masteredCandidate], candidate, now);
  expect(result).toHaveLength(1);
  expect(result[0].learningState).toBe("learning");
  expect(result[0].card.due).toBe(now.toISOString());
});
```

另测同一单词但不同原句时仍追加为不同语境记录，且两张卡的 ID 不同。

- [x] **Step 2: 运行测试并确认失败**

Run: `npm test -- src/lib/vocabulary.test.js`  
Expected: FAIL，`src/lib/vocabulary.js` 尚不存在。

- [x] **Step 3: 实现幂等写入和阅读器标记状态**

增加 `translate / vocabulary` 两种交互模式，默认 `translate`。标记模式下，同一选词再次点击不收起；单词或短语在缓存、预生成或新翻译成功后自动保存。用待标记的词键匹配异步结果，旧请求完成不得标记新选词；失败和中止不产生记录。所有保存都走 `upsertVocabularyItem`，普通“收藏”也复用该接口。

- [x] **Step 4: 运行标记、点词和复习回归测试**

Run: `npm test -- src/lib/vocabulary.test.js src/lib/annotation-click.test.js src/lib/reader.test.js src/lib/review-session.test.js`  
Expected: PASS；普通点词仍默认收起/展开，标记模式不重复建卡。

- [x] **Step 5: 提交阅读器标记变更**

```bash
git add src/lib/vocabulary.js src/lib/vocabulary.test.js src/screens/ReaderScreen.jsx src/styles.css
git commit -m "feat: add continuous vocabulary marking"
```

### Task 5: 备份版本 2 与严格校验

**Files:**
- Modify: `src/lib/backup.js`
- Modify: `src/lib/backup.test.js`
- Modify: `src/screens/DataManagement.jsx`（仅在预览中增加已掌握数量，不改变恢复流程）。

**Interfaces:**
- Changes: `buildBackup(...)` 输出 `schemaVersion: 2`，所有生词含规范化 `learningState` 和可空的 `masteredAt`。
- Changes: `parseBackup(text)` 只接受版本 2；当前没有正式旧版用户，不增加版本 1 迁移分支。
- Keeps: 现有 bucket 名称、导入书籍、快照和失败回滚；不增加密钥或模型配置字段。

- [x] **Step 1: 写版本拒绝和损坏状态测试**

```js
it("rejects unsupported backup versions instead of migrating them", () => {
  const unsupported = buildBackup(input());
  unsupported.schemaVersion = 1;
  expect(() => parseBackup(JSON.stringify(unsupported))).toThrow("不支持");
});

it("rejects an invalid mastered state before snapshotting current data", () => {
  const invalid = buildBackup(input());
  invalid.buckets.vocabulary[0].learningState = "finished";
  expect(() => parseBackup(JSON.stringify(invalid))).toThrow("生词");
});
```

保留并更新现有“无凭据、类型校验、恢复前验证、失败回滚、回滚也失败时诚实报告”测试。

- [x] **Step 2: 运行备份测试并确认版本断言失败**

Run: `npm test -- src/lib/backup.test.js`  
Expected: FAIL，当前只接受并导出版本 1。

- [x] **Step 3: 实现版本 2 导出和严格读取**

版本 2 的非枚举状态、缺失状态和非法掌握日期必须拒绝。恢复仍先解析再快照，任何写入失败沿用现有回滚，不添加额外存储 bucket 或旧版迁移分支。

- [x] **Step 4: 运行备份、存储与数据管理相关测试**

Run: `npm test -- src/lib/backup.test.js src/lib/storage.test.js src/lib/review-session.test.js`  
Expected: PASS；预览计数与实际学习/掌握记录一致，备份文本不含密钥字段值。

- [x] **Step 5: 在用户明确要求后提交备份变更**

### Task 6: 端到端验收与文档同步

**Files:**
- Modify: `docs/project-overview.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-11-13-lightweight-personal-reader-design.md`

- [x] **Step 1: 运行完整前端测试和生产构建**

Run: `npm test && npm run build:web && npm run build:admin`  
Expected: 全部 PASS，两个构建及产物断言均成功。

- [x] **Step 2: 在桌面视口走通真实学习闭环**

启动本地阅读端，用内置文章完成：普通点词不自动收藏；开启生词标记后连续保存两个词；重复点击不重复；刷新后仍存在；首屏不泄露答案；不认识会当前批重排；认识后四档自评；掌握、撤销、恢复复习和“原文”定位均正确。使用缓存命中路径时不得为重复标记再次调用云端翻译。

- [x] **Step 3: 在手机视口和键盘路径回归**

检查 390px 左右视口的标记按钮、行间注空间、复习按钮和掌握列表；检查 Space、1–4、Ctrl/Cmd+Z、焦点与原生按钮行为。再验证全文朗读、句译、划线和章节位置未被标记模式破坏。

- [x] **Step 4: 验证备份的实际导出与恢复**

导出包含学习和掌握词的 JSON，确认版本为 2 且无凭据；执行一次真实恢复，再模拟一次写入失败确认回滚。不得用真实个人 Key 或私有数据做测试样本。

- [x] **Step 5: 更新文档和实际状态**

把项目说明中的生词流程改为最终实现，将设计文档阶段 1 的对应项标为完成，并在 `CHANGELOG.md` 记录真实功能、备份格式和验证结果。若实现与计划有偏差，同步更新计划，不保留描述旧行为的注释或文档。

- [x] **Step 6: 检查工作区并提交已验收变更**

Run: `git status --short`  
Expected: 只有本阶段预期文件，没有测试日志、临时截图或凭据文件。随后提交文档与剩余验收变更。

```bash
git add README.md AGENTS.md CHANGELOG.md docs/project-overview.md docs/superpowers
git commit -m "docs: record vocabulary learning loop"
```
