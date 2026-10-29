# 苏打阅读内容管道运维

## 费用边界

- 保持 `PAID_PROVIDER_ENABLED=false` 和 `DAILY_PAID_BUDGET_CNY=0`，可阻断常规付费兜底。
- DeepSeek 及被标记为 `cheap_api` 的自定义低价 API 是例外，配置后仍可能参与导读或翻译并产生费用。要求完全零费用时，不要配置这些密钥，并把它们从 `EDITORIAL_PROVIDER_ORDER` 和 `TRANSLATION_PROVIDER_ORDER` 中移除。
- 免费模型全部失败且没有低价 API 例外时，导读生成返回“不可用”，不会自动调用腾讯、百炼或硅基流动 72B。
- 采集本身只访问公开 API/RSS，不需要代理池、验证码服务或付费搜索 API。
- 如果未来启用其他付费路由，必须同时由管理员打开总开关并设置正数预算。

## 上线前观察

当前版本不运行影子采集，每日任务直接构建次日内容。首次启用自动发布前，仍建议连续观察至少 7 天：

1. 每天查看 `/admin` 中的抓取数量、重复率、主题覆盖和来源错误。
2. 抽查候选链接、日期、摘要完整性和主题分类。
3. 确认所有非 `soda-editorial` 来源的 `fullTextAllowed` 都为 `false`。
4. 抽查生成导读中的数字、日期、因果词和论文局限性是否有对应来源。
5. 确认自动发布失败时仍使用最近 7 天内未向该用户推荐过的备用导读。

## 调度

生产任务由 `.github/workflows/daily-content.yml` 执行，不需要常驻 Celery Beat：

- 每天北京时间 21:17（UTC 13:17）运行；GitHub 定时任务可能略有延迟。
- 每次采集 500–2000 条候选，为活跃用户需要的等级构建次日版，最多 12 个版本。
- `concurrency` 阻止同一工作流并发运行；正在执行的任务不会被新触发取消。
- 可通过 `workflow_dispatch` 手动补跑，并用 `run_id` 保证调用方幂等。

## 故障处理

- HTTP 429：遵守 `Retry-After`，指数退避，来源健康度降级。
- HTTP 5xx/超时：最多三次带随机抖动的重试；持续失败进入管理页复核。
- ETag/Last-Modified：稳定 RSS、Sitemap 和 HTML 端点使用条件请求；分页 API 不跨页复用 ETag。
- arXiv 高负载：来源可以暂时失败，其他来源继续完成；预印本始终带“未同行评审”风险标记。
- 数据库或发布事务失败：不会覆盖现有 `DailyEdition`。

## 生产检查

```powershell
cd backend
python -m pytest
python -m compileall app scripts
```

随后在 GitHub Actions 手动运行 `Daily learning content`，确认数据库连接、内容生成和发布结果；该步骤会写入次日内容，不应只作为无副作用的检查命令执行。

前端：

```powershell
npm test
npm run build
```
