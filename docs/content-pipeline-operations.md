# 苏打阅读内容管道运维

## 零费用边界

- 保持 `PAID_PROVIDER_ENABLED=false` 和 `DAILY_PAID_BUDGET_CNY=0`。
- 免费模型全部失败时，导读生成返回“不可用”，不会自动调用腾讯、百炼、DeepSeek 或硅基流动 72B。
- 采集本身只访问公开 API/RSS，不需要代理池、验证码服务或付费搜索 API。
- 如果未来启用付费路由，必须同时由管理员打开总开关并设置正数预算。

## 影子采集

上线前连续运行 7 天：

1. 每天查看 `/admin` 中的抓取数量、重复率、六主题覆盖和来源错误。
2. 抽查候选链接、日期、摘要完整性和主题分类。
3. 确认所有非 `soda-editorial` 来源的 `fullTextAllowed` 都为 `false`。
4. 只在来源稳定后运行 `generate=true`，并人工审核所有生成导读。
5. 自动发布前，至少抽查数字、日期、因果词和论文局限性是否有对应来源。

## 调度

Celery Beat 必须只有一个实例。任务时间按 `Asia/Shanghai`：

- `00:15 / 06:15 / 12:15 / 18:15`：增量发现。
- `21:00`：500–2000 条自适应采集并准备导读。
- `23:30`：检查每个主题是否至少有 5 个候选。
- `00:00`：按日期幂等发布；无新内容时继续使用最近 7 天备用池。

## 故障处理

- HTTP 429：遵守 `Retry-After`，指数退避，来源健康度降级。
- HTTP 5xx/超时：最多三次带随机抖动的重试；持续失败进入管理页复核。
- ETag/Last-Modified：稳定 RSS、Sitemap 和 HTML 端点使用条件请求；分页 API 不跨页复用 ETag。
- arXiv 高负载：来源可以暂时失败，其他来源继续完成；预印本始终带“未同行评审”风险标记。
- 数据库或发布事务失败：不会覆盖现有 `DailyEdition`。

## 生产检查

```powershell
cd backend
python -m alembic upgrade head
python -m pytest
python -m celery -A app.celery_app:celery_app inspect registered
```

前端：

```powershell
npm test
npm run build
```
