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
3. 确认全文权限都有明确使用依据；仅索引来源保持 `fullTextAllowed=false`，外链或第三方权利不明的文本必须降级为仅索引。
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

首批备考内容位于 `backend/content/exams/*.json`，当前是 CET4、CET6、考研各一篇科普和一篇故事，共 6 篇、24 道四选一题，全部标为 `original / 原创模拟`，不包含真题。高中首批另有 4 篇、16 题，位于 `backend/content/high-school/*.json`，同样全部为原创模拟。

在 `backend/` 目录执行：

```powershell
$env:PYTHONPATH="."
python scripts/import_exam_content.py content/exams
python scripts/import_exam_content.py content/high-school
```

- 每篇包含稳定 `id`、正文、CEFR、独立 `examTrack`、`contentOrigin`、4 道题及完整 `provenance`。
- 外部内容必须填写 HTTPS `sourceUrl`、`retrievedAt`、`license`、`usageBasis`、`sourceLabel/sourceId` 和核验时间；来源和使用依据由内容编辑核验。只有核验通过的 `official_exam / licensed_exam` 才能标“真题”，`adapted / original` 分别标“改编 / 原创模拟”。
- 答案、中文解析和原文依据需由内容编辑逐题核对，并填写 `answersReviewedAt`。确定性校验负责结构、选项去重、题号唯一、答案范围和精确证据句定位，不宣称自动证明语义答案正确，也不为出题调用模型。
- 任一文件无效时整批回滚。完全相同的包可幂等重导；同 ID 的正文、题目、来源或其他内容发生变化时必须使用新 ID，不能静默覆盖已有学习记录所指向的内容。
- 阅读端通过免登录 `GET /exams/catalog?track=cet4|cet6|postgraduate` 获取目录；不传轨道返回三轨道内容。CET4/CET6/考研不进入 `/feed/daily`，考试 API 失败不影响普通馆藏和本地书籍。高中内容通过每日轨道提供，见下文。
- 答题与解析揭示只存在当前组件会话，不保存成绩、不进入 FSRS 或个人备份；收藏生词仍复用现有文章 ID、章节和原句。


## 第四阶段：规则优先审核与可观测性

- 审核先执行许可、语言、篇幅、新鲜度、来源质量和确定性安全规则，再决定是否调用模型。严肃、批评或有争议的内容不会因情绪倾向被拒绝。
- 确定性规则检查标题、摘要和最多 6 个已保存正文段落（合计最多 4000 字符）。明确仇恨、露骨内容、危险指导和标题党直接拒绝；健康保证等边界表述进入 `review`。正文风险命中只保留最多 2 段、每段 500 字符的风险片段。
- AI 审核使用独立 `content_moderation` 路由和同一个 `model_center.db`。输入只含标题（240 字符）、摘要（1200 字符）、来源、主题、规则风险标记和风险片段，不发送完整正文。
- 每次运行最多审核 6 个边界候选。只有 `decision=approve` 且置信度不低于 0.85 才通过；低置信、拒绝、无效 JSON、超时、无模型和超出上限均不自动发布。纯发现运行（`generate=false` 且 `publish=false`）不主动调用 AI。
- 审核结果以 `content-moderation-v2` 和内容哈希持久化在候选元数据中，不保存提示词或响应全文。相同内容不重复调用模型，付费线路继续受总开关、每日预算和单次上限约束。
- `/admin` 的最近运行展示重复率、六主题覆盖、普通/高中发布数和拒绝原因；候选行展示具体原因。`review` 表示边界候选，不是人工复核队列。

## 新增政府来源与第三方材料

2026-11-16 实际访问并验证以下来源：

- [NSF News RSS](https://www.nsf.gov/rss/rss_www_news.xml)：[NSF Web Policies](https://www.nsf.gov/policies/digital) 说明多数由政府雇员制作的文字可复制，明确标示的第三方文字和视觉材料需另行处理。
- [DOE Energy News RSS](https://www.energy.gov/rss/articles.xml)：[DOE Web Policies](https://www.energy.gov/about-us/web-policies) 说明政府网站信息属于公有领域，但第三方供稿或许可材料仍受版权限制。

实现约束：

- 只抽取文字，不复制图片、标识或视觉材料。NSF 只允许 `nsf.gov` 及其子域正文，DOE 只允许 `energy.gov` 及其子域正文；外部链接不抓取，只保留索引。
- 遇到 `All rights reserved`、版权标识、经许可转载或第三方权利不明文本时，`fullTextAllowed=false`，不保存正文，不用政府来源许可覆盖第三方材料。
- 2026-11-16 最终适配器检查：NSF 返回 1 篇、12 段；DOE 返回 3 篇、分别为 8/10/9 段，均通过当前权限检查。网络结果会变化，不作为每日数量保证。

## 高中每日轨道与降级

- `backend/content/high-school/` 首批包含校园、成长、自然、文化四篇原创模拟，覆盖 A2/B1/B2，每篇 4 题。答案、中文解析、完整证据句和核验时间均经内容包校验。
- 每日版本从高中池最多选 2 篇且主题不重复，优先保证一篇 B1，另一篇优先覆盖其他 CEFR；后续版本继续避开近 7 天重复。普通与高中发布数写入 `DailyEdition.coverage.tracks`。
- `GET /feed/daily?track=daily|high_school`：默认 `daily` 混合普通和高中内容；`high_school` 只从高中实时池选择。CET4/CET6/考研始终排除，推荐缓存包含轨道，切换不会复用旧轨道结果。
- 今日页提供「日常 / 高中」切换，轨道偏好保存在浏览器。CEFR 精确匹配优先于轨道和兴趣；高中缺少该级别时使用同级普通备用文，标记备用，不把普通文伪装成高中文或打开空卡片。
- 高中阅读复用答题、解析、收藏、本文复习和原文返回。离线词典补充 `library / avoid / reveal / responsibility / pollinators / accuracy`，无密钥时也能完成这些词的收藏闭环。
- 单一来源失败不阻断其他来源；本轮不足 3 篇可发布正文时返回 0，不覆盖既有 `DailyEdition`。2026-11-16 故障模拟中，NSF 异常、另一来源完成，8 个既有文章 ID 和高中正文均保留。

## 第五阶段准备度

已具备：`daily_article` 独立路由、共享预算与用量记录、来源与候选池、有界证据、既有生成结果校验、失败备用文章和本机内容数据库。

尚未实现：读者确认入口、兴趣/形式/篇幅参数、每日文章专用证据装配、Asia/Shanghai 自然日生成锁与每日缓存、刷新防重复生成，以及读者端完整生成/降级验收。阶段 5 尚未开始，不提前勾选。
