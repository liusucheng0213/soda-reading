# 苏打阅读内容管道运维

## 零费用边界

- 保持 `PAID_PROVIDER_ENABLED=false`、`DAILY_PAID_BUDGET_CNY=0` 和 `PAID_FALLBACK_MODE=never`。
- 所有 `may_charge=True` 的线路都会被阻断，包括 DeepSeek、cheapApi、自定义 OpenAI 兼容线路、腾讯、百炼和可能计费的硅基流动模型。廉价或自定义不是预算豁免理由。
- 免费模型全部失败时，导读生成返回“不可用”，不会转而调用被阻断的付费线路。
- 采集本身只访问公开 API/RSS，不需要代理池、验证码服务或付费搜索 API。
- 如明确启用付费路由，必须同时打开总开关、设置正数每日预算和单次上限，并满足请求模式。预算使用共享 SQLite 估算预留，不替代供应商控制台的费用上限与告警。

## 影子采集

上线前连续运行 7 天：

1. 每天查看 `/admin` 中的抓取数量、重复率、六主题覆盖和来源错误。
2. 抽查候选链接、日期、摘要完整性和主题分类。
3. 确认所有非 `soda-editorial` 来源的 `fullTextAllowed` 都为 `false`。
4. 只在来源稳定后运行 `generate=true`，并人工审核所有生成导读。
5. 自动发布前，至少抽查数字、日期、因果词和论文局限性是否有对应来源。

## 调度

在本机管理站点「采集并发布」。内容库是本地 SQLite（`backend/data/soda_content.db`）。没有定时任务，也没有单独的队列进程。

## 故障处理

- HTTP 429：遵守 `Retry-After`，指数退避，来源健康度降级。
- HTTP 5xx/超时：最多三次带随机抖动的重试；持续失败进入管理页复核。
- ETag/Last-Modified：稳定 RSS、Sitemap 和 HTML 端点使用条件请求；分页 API 不跨页复用 ETag。
- arXiv 高负载：来源可以暂时失败，其他来源继续完成；预印本始终带“未同行评审”风险标记。
- 数据库或发布事务失败：不会覆盖现有 `DailyEdition`。

## 生产检查

```powershell
cd backend
$env:PYTHONPATH="."
python -m pytest
```

前端：

```powershell
npm test
npm run build:web
npm run build:admin
```

## 考试内容包

首批内容位于 `backend/content/exams/*.json`，当前是 CET4、CET6、考研各一篇科普和一篇故事，共 6 篇、24 道四选一题，全部标为 `original / 原创模拟`，不包含真题。高中内容尚未导入。

在 `backend/` 目录执行：

```powershell
$env:PYTHONPATH="."
python scripts/import_exam_content.py content/exams
```

- 每篇包含稳定 `id`、正文、CEFR、独立 `examTrack`、`contentOrigin`、4 道题及完整 `provenance`。
- 外部内容必须填写 HTTPS `sourceUrl`、`retrievedAt`、`license`、`usageBasis`、`sourceLabel/sourceId` 和核验时间；来源和使用依据由内容编辑核验。只有核验通过的 `official_exam / licensed_exam` 才能标“真题”，`adapted / original` 分别标“改编 / 原创模拟”。
- 答案、中文解析和原文依据需由内容编辑逐题核对，并填写 `answersReviewedAt`。确定性校验负责结构、选项去重、题号唯一、答案范围和精确证据句定位，不宣称自动证明语义答案正确，也不为出题调用模型。
- 任一文件无效时整批回滚。完全相同的包可幂等重导；同 ID 的正文、题目、来源或其他内容发生变化时必须使用新 ID，不能静默覆盖已有学习记录所指向的内容。
- 阅读端通过免登录 `GET /exams/catalog?track=cet4|cet6|postgraduate` 获取目录；不传轨道返回三轨道内容。考试文章不进入普通 `/feed/daily`，考试 API 失败不影响普通馆藏和本地书籍。
- 答题与解析揭示只存在当前组件会话，不保存成绩、不进入 FSRS 或个人备份；收藏生词仍复用现有文章 ID、章节和原句。
