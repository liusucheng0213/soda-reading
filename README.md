# 苏打阅读 · 内部云端版

面向中文读者的英语沉浸阅读工具，包含响应式网页、独立管理站和 Android App。当前定位为不超过 6 名熟人使用的内部产品：不开放注册、不上架应用商店，用户导入的书籍只保留在浏览器或 Android 沙盒中。

阅读器的产品说明与使用方法见 **[项目说明](docs/project-overview.md)**；本页重点介绍当前能力、架构、本地开发、内部云部署与费用边界。

## 当前能力

- **内部账号**：管理员创建用户名与随机临时密码，首次登录强制改密；支持停用账号、重置密码、撤销会话和查看设备。
- **沉浸阅读**：暖白日间、深墨蓝夜间；词义显示在被点击单词下方，句译插入原句下方，再次点击收起。
- **本地导入**：EPUB、TXT（UTF-8 / 常见 UTF-16）和文本型 PDF，单文件上限 50 MB；扫描件不做 OCR。
- **学习记录**：阅读进度、生词、FSRS 复习、偏好、设备与离线同步队列；每天默认 20 张生词卡，可调为 10–50。
- **每日内容**：采集 500–2000 条候选，只为活跃用户需要的 CEFR 等级生成内容，最多 12 个版本；推荐文章预生成句译和 15–25 个重点词义。
- **自动校验**：许可、语言、篇幅、新鲜度和质量分由管道验证；管理站展示通过 / 抓取状态，不设闲置的人工复核队列。
- **云端与运维**：Supabase PostgreSQL、Auth、RLS、Edge Functions 和共享翻译缓存；GitHub Actions 定时内容、额度记录、age 加密备份与 Android 内部构建。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [项目说明](docs/project-overview.md) | 产品定位、阅读器交互、技术结构与产品硬规则 |
| [内部云部署](docs/internal-cloud-deployment.md) | Supabase、Cloudflare、工作流和上线验收 |
| [翻译服务配置](docs/translation-provider-setup.md) | 模型申请、路由、缓存与费用保护 |
| [内容管道运维](docs/content-pipeline-operations.md) | 内容采集、调度和故障处理 |
| [Android 内部分发](docs/android-internal-release.md) | 签名、APK、哈希校验和 OTA |
| [备份恢复手册](docs/backup-restore-runbook.md) | 加密备份与恢复演练 |

## 架构

```text
Web / Android
  ├─ 本地文件、SQLite / IndexedDB、一级缓存
  └─ Supabase Auth + RLS
       ├─ 用户进度、生词、复习、偏好、设备
       ├─ Edge Functions：翻译、推荐、管理员操作
       └─ PostgreSQL：共享缓存、内容、证据、额度

GitHub Actions（每天 21:17 北京时间）
  ├─ Python 内容管道 → 次日 DailyEdition
  └─ pg_dump → age 公钥加密 → 14 天 Artifact
```

生产环境不需要常驻 FastAPI、Redis 或 Celery。`backend/` 中的 FastAPI 是本地开发兼容层；Python 内容管道由 GitHub Actions 直接连接 Supabase PostgreSQL。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/` | 响应式用户网页与管理站界面 |
| `apps/mobile/` | Expo Router Android App |
| `apps/mobile/modules/soda-pdfbox/` | 本地文本型 PDF 抽取原生模块 |
| `packages/core/` | 分词、句切分、正文哈希和 FSRS 共享逻辑 |
| `packages/api-client/` | Web / Android 共用的 Supabase 客户端 |
| `supabase/migrations/` | 云数据库迁移源与 RLS |
| `supabase/functions/` | 翻译、每日推荐、改密和管理员函数 |
| `backend/app/content_*` | 来源适配、筛选、聚类、事实追溯和分级导读 |
| `.github/workflows/` | 内容、备份、质量检查、APK 和 OTA |
| `docs/` | 部署、分发、运维与恢复手册 |
| `reference-reader.png` | 阅读界面视觉基准 |

## 本地运行网页

推荐使用 Node.js 20+。未连接云端时，网页使用内置演示数据和本地存储，可直接体验阅读流程。

```powershell
npm ci
npm run dev -- --host 0.0.0.0 --port 4173 --strictPort
```

连接 Supabase 时，复制根目录 `.env.example` 为 `.env.local`，只填写公开的 Project URL 和 anon key：

```dotenv
VITE_SUPABASE_URL=https://你的项目.supabase.co
VITE_SUPABASE_ANON_KEY=你的-anon-key
VITE_ENABLE_ADMIN=false
```

如需使用本地 FastAPI 翻译兼容层，按 [`docs/translation-provider-setup.md`](docs/translation-provider-setup.md) 配置 `backend/.env`，并从 `backend/` 启动：

```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

本地 FastAPI 的密码登录默认关闭；仅在确有需要时，在 `backend/.env` 中单独设置 `LOCAL_ADMIN_PASSWORD`。该服务是开发兼容层，不要以 `APP_ENV=development` 暴露到公网；生产管理接口必须设置独立的 `ADMIN_API_TOKEN`。

**密钥边界**：service role、数据库密码、模型密钥和 GitHub Token 不得放入 `VITE_*`、`EXPO_PUBLIC_*` 或前端源码。

## 本地验证 Supabase

需要 Docker Desktop。首次启动并执行迁移：

```powershell
npx supabase start
npx supabase db reset
```

另开终端启动本地 Edge Functions：

```powershell
npx supabase functions serve
```

以下脚本验证关闭注册、RLS 用户隔离、角色越权、停用账号、管理员创建与重置账号、旧会话撤销、预生成推荐及模型不可用时的结构化错误：

```powershell
$status = npx supabase status -o json | ConvertFrom-Json
$env:SUPABASE_URL = $status.API_URL
$env:SUPABASE_ANON_KEY = $status.ANON_KEY
$env:SUPABASE_SERVICE_ROLE_KEY = $status.SERVICE_ROLE_KEY
npm run test:supabase
npm run test:edge
```

本地测试密钥只用于本机容器，不要提交到仓库。

## 创建首位管理员

云端迁移完成后，只在管理员自己的电脑运行：

```powershell
$env:SUPABASE_URL="https://你的项目.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="你的-service-role-key"
$env:SODA_ADMIN_USERNAME="admin"
node scripts/bootstrap-admin.mjs
```

脚本生成至少 16 位的临时密码并且只显示一次。管理员登录后必须先改密，并用新密码重新登录一次以撤销临时密码会话；随后可在独立管理站创建最多 6 个读者账号。用户名映射到不可投递的内部占位邮箱，不收集读者手机号或真实邮箱。

## 翻译路由与费用边界

查找顺序：

1. 推荐文章优先使用随文章下发的句译和词表。
2. 再查设备缓存和 PostgreSQL 30 天共享缓存。
3. 缺少缓存时才调用模型，并按质量 50%、近期成功率 30%、P95 延迟 20%动态排序。
4. 智谱高负载或限流时短时熔断，再尝试 ModelScope 和允许列表中的硅基流动免费型号。
5. 当前可用线路全部失败时返回结构化 503，不伪造翻译结果。

生产变量保持：

```dotenv
PAID_PROVIDER_ENABLED=false
DAILY_PAID_BUDGET_CNY=0
PAID_FALLBACK_MODE=never
CONTENT_DISCOVERY_MIN=500
CONTENT_DISCOVERY_MAX=2000
CONTENT_MAX_DAILY_VARIANTS=12
CONTENT_AUTO_PUBLISH=true
CONTENT_PUBLISH_OFFSET_DAYS=1
CONTENT_TIMEZONE=Asia/Shanghai
```

> **费用例外必须注意**：`PAID_PROVIDER_ENABLED=false` 会阻断常规付费兜底，但代码明确允许 DeepSeek 及被标记为 `cheap_api` 的自定义低价 API 继续参与路由，这些服务仍可能计费。因此，“不自动启用付费兜底”不等于“绝对零费用”。如果要求完全零费用，不要配置这些接口的密钥，并把它们从翻译与导读路由中移除；同时以各平台控制台为准设置额度和告警。

内容采集顺序为官方 API、RSS / Atom、Sitemap、获准网页解析。普通网页只存元数据和短摘要；只有来源策略明确允许全文时才保存正文。不绕过登录、付费墙、验证码或反爬机制。

每日任务直接为次日构建合格内容；失败时继续使用最近 7 天内未向该用户推荐过的备用导读，不再运行影子采集。

## Android

Android App 支持登录、今日推荐、书架、本地导入、沉浸阅读、生词复习、设置、通知和离线同步。PDFBox 属于原生依赖，因此文本型 PDF 不能用通用 Expo Go 验证，必须使用 development build 或 APK。

```powershell
npm run typecheck:mobile
cd apps/mobile
npx expo export --platform android
npx expo prebuild --platform android
```

首次关联 Expo 后构建内部 APK：

```powershell
cd apps/mobile
npx eas-cli login
npx eas-cli init
npx eas-cli build --platform android --profile preview
```

完整签名、私聊分发、哈希校验和 OTA 步骤见 [Android 内部分发文档](docs/android-internal-release.md)。

## 全量检查

```powershell
npm test
npm run build:web
npm run build:admin
npm run typecheck:mobile

cd backend
$env:PYTHONPATH="."
python -m pytest
python -m compileall app scripts
```

内部云部署按 [部署文档](docs/internal-cloud-deployment.md) 执行；首次和每月恢复演练按 [备份恢复手册](docs/backup-restore-runbook.md) 执行。
