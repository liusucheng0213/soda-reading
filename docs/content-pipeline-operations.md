# 苏打阅读内容管道运维

## 零费用边界

- 保持 `PAID_PROVIDER_ENABLED=false`、`DAILY_PAID_BUDGET_CNY=0` 和 `PAID_FALLBACK_MODE=never`。
- 所有 `may_charge=True` 的线路都会被阻断，包括 DeepSeek、cheapApi、自定义 OpenAI 兼容线路、腾讯、百炼和可能计费的硅基流动模型。廉价或自定义不是预算豁免理由。
- 免费模型全部失败时，导读生成返回“不可用”，不会转而调用被阻断的付费线路。
- 采集本身只访问公开 API/RSS，不需要代理池、验证码服务或付费搜索 API。
- 如明确启用付费路由，必须同时打开总开关、设置正数每日预算和单次上限，并满足请求模式。预算是进程内估算预留，不替代供应商控制台的费用上限与告警。

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
