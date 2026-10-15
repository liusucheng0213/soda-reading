# 苏打阅读 · 内部云端版

产品是什么、阅读器怎么用、目录和本地开发，见 **[docs/project-overview.md](docs/project-overview.md)**。下文偏内部云部署、账号与免费额度。

苏打阅读是供不超过 6 名熟人使用的英语阅读工具，包含响应式网页、独立管理站和 Android App。它不开放注册、不上架应用商店，也不会上传用户导入的书籍。

当前版本已经实现：

- 管理员创建用户名与随机临时密码；首次登录强制改密。
- 管理员停用账号、重置密码、撤销全部会话和查看设备。
- Supabase PostgreSQL、Auth、RLS、Edge Functions 与共享翻译缓存。
- 暖白日间、深墨蓝夜间的响应式阅读器。
- 词义直接显示在被点击单词下方，句译直接插入原句下方；再次点击收起。
- 推荐文章预生成句译和 15–25 个重点词义，点击不再等待模型。
- EPUB、TXT（UTF-8，以及带 BOM 或英文空字节特征的 UTF-16）、文本型 PDF 本地导入；50 MB 限制，文件只留在浏览器或 Android 沙盒。
- 阅读进度、生词、FSRS 复习、偏好、设备与离线同步队列。
- 每日 20 张生词卡，支持“忘记、困难、良好、简单”，范围可调为 10–50。
- 每天采集 500–2000 条候选，只生成活跃用户需要的等级，最多 12 个版本。
- 低风险且质量分不低于 85 的导读自动进入次日版；许可、语言、篇幅和新鲜度由管道自动验证，管理站只显示通过/抓取，不设人工复核队列。
- 智谱、ModelScope、硅基流动免费模型动态路由；所有付费路由硬关闭。
- GitHub Actions 定时内容任务、免费额度记录、age 加密备份和 Android 内部构建。

## 架构

```text
Web / Android
  ├─ 本地文件、SQLite / IndexedDB、一级缓存
  └─ Supabase Auth + RLS
       ├─ 用户进度、生词、复习、偏好、设备
       ├─ Edge Functions：翻译、推荐、管理员操作
       └─ PostgreSQL：共享缓存、内容、证据、额度

GitHub Actions（每天 21:17 北京时间）
  ├─ Python 高质量内容管道 → 次日 DailyEdition
  └─ pg_dump → age 公钥加密 → 14 天 Artifact
```

生产环境不需要常驻 FastAPI、Redis 或 Celery。`backend/` 中的 FastAPI 仅保留为本地开发兼容层；Python 内容管道由 GitHub Actions 直接连接 Supabase PostgreSQL。

## 目录

- `src/`：响应式用户网页和管理后台界面。
- `apps/mobile/`：Expo Router Android App。
- `apps/mobile/modules/soda-pdfbox/`：本地文本 PDF 抽取原生模块。
- `packages/core/`：分词、句切分、正文哈希和 FSRS 共享逻辑。
- `packages/api-client/`：Web/Android 共用的 Supabase 客户端。
- `supabase/migrations/`：云数据库唯一迁移源与全部 RLS。
- `supabase/functions/`：免费翻译、每日推荐、改密和管理员函数。
- `backend/app/content_*`：来源适配、筛选、聚类、事实追溯和分级导读。
- `.github/workflows/`：内容、备份、质量检查、APK 和 OTA 更新。
- `docs/`：内部部署、Android 分发与恢复演练手册。
- `reference-reader.png`：阅读界面视觉基准。

## 本地运行网页

不连接云端时，网页会使用内置本地演示数据；开发环境可用本地演示账号进入界面。正式构建没有公开注册入口。

```powershell
npm install
npm run dev -- --host 0.0.0.0 --port 4173 --strictPort
```

连接 Supabase 时，复制根目录 `.env.example` 为 `.env.local`，只填写公开的 Project URL 和 anon key：

```dotenv
VITE_SUPABASE_URL=https://你的项目.supabase.co
VITE_SUPABASE_ANON_KEY=你的-anon-key
VITE_ENABLE_ADMIN=false
```

service role、数据库密码、模型密钥和 GitHub Token 绝不能放入 `VITE_*` 或 `EXPO_PUBLIC_*`。

## 本地验证 Supabase

需要 Docker Desktop。首次启动和迁移：

```powershell
npx supabase start
npx supabase db reset
```

启动本地 Edge Functions：

```powershell
npx supabase functions serve
```

测试脚本会验证关闭注册、RLS 用户隔离、禁止角色越权、停用账号、管理员创建与重置账号、旧会话撤销、预生成推荐和免费模型全部失败时返回 503：

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

脚本生成至少 16 位的临时密码并且只显示一次。管理员登录后必须先改密，并用新密码重新登录一次以撤销临时密码会话；随后可在独立管理站创建最多 6 个读者账号。用户名会映射到不可投递的内部占位邮箱，不收集朋友的手机号或邮箱。

## 免费翻译与内容

Edge Function 的固定规则是：

1. 推荐文章优先使用随文章下发的句译和词表。
2. 再查设备缓存和 PostgreSQL 30 天共享缓存。
3. 仅在缺少缓存时调用免费模型，并按质量 50%、近期成功率 30%、P95 延迟 20%动态排序。
4. 智谱高负载或限流时短时熔断，再尝试 ModelScope 和允许列表中的硅基流动免费型号。
5. 全部免费线路不可用时返回结构化 503；不会调用任何付费模型。

关键生产变量固定为：

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

内容采集顺序是官方 API、RSS/Atom、Sitemap、获准网页解析。普通网页只存元数据和短摘要；只有来源策略明确允许全文时才保存正文。不绕过登录、付费墙、验证码或反爬机制。

本项目不再运行影子采集。每日任务直接为次日构建合格内容；失败时继续使用最近 7 天内未向该用户推荐过的备用导读。

## Android

Android App 支持登录、今日推荐、书架、本地导入、沉浸阅读、生词复习、设置、通知和离线同步。PDFBox 属于原生依赖，因此文本 PDF 不能用通用 Expo Go 验证，必须使用 development build 或 APK。

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

更完整的签名、私聊分发、哈希校验和 OTA 更新步骤见 [`docs/android-internal-release.md`](docs/android-internal-release.md)。

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

内部云部署按 [`docs/internal-cloud-deployment.md`](docs/internal-cloud-deployment.md) 执行；首次和每月恢复演练按 [`docs/backup-restore-runbook.md`](docs/backup-restore-runbook.md) 执行。
