# 苏打阅读内部云端部署手册

这套部署面向不超过 6 名熟人。网页登录壳可以被公网访问，但没有注册入口；用户数据由 Supabase Auth 与 RLS 隔离，管理站还要经过 Cloudflare Access。用户导入的书籍不会上传。

## 1. 准备四个平台

创建一个 Supabase Free 项目、一个私有 GitHub 仓库、两个 Cloudflare Pages 项目和一个 Expo 项目。不要购买域名，不要在任何平台绑定自动升级套餐。

- [Supabase](https://supabase.com/dashboard)：新建免费项目，记下 Project URL、anon key、service role key 和 Direct connection 数据库地址。
- [GitHub](https://github.com/new)：建立私有仓库。每日内容和备份都从这里运行。
- [Cloudflare Pages](https://dash.cloudflare.com/)：稍后分别创建 `soda-reading` 与 `soda-reading-admin`。
- [Expo](https://expo.dev/signup)：用于私下构建 APK，不提交应用商店。

service role key、数据库连接串、模型密钥和 GitHub workflow token 都是服务端秘密，绝不能放入 `VITE_*` 或 `EXPO_PUBLIC_*` 变量。

## 2. 建立 Supabase 数据库

安装并登录 CLI：

```powershell
npx supabase login
npx supabase link --project-ref 你的项目ref
npx supabase db push
```

`supabase/migrations` 是唯一云数据库迁移源。2026-10-15 新增的迁移包括文章中文导读 `intro_zh`、生词原句键 `sentence_key`，以及常见义 `common_translation` 和文中指代 `referent`。未推送前，网页会退回旧的生词保存方式，这两项注释先留在本机。推送后，在 Supabase Dashboard 的 Authentication → Providers 中再次确认：

- Allow new users to sign up：关闭。
- Anonymous sign-ins：关闭。
- JWT expiry：1 小时。
- 不启用短信或公开邮件注册。

本地测试可使用：

```powershell
npx supabase start
npx supabase db reset
```

## 3. 部署 Edge Functions

先设置只存在于服务器的密钥：

```powershell
npx supabase secrets set ZHIPU_API_KEY=你的密钥
npx supabase secrets set MODELSCOPE_ACCESS_TOKEN=你的密钥
npx supabase secrets set SILICONFLOW_API_KEY=你的密钥
npx supabase secrets set ALLOWED_ORIGINS=https://用户站.pages.dev,https://管理站.pages.dev
npx supabase secrets set GITHUB_REPOSITORY=你的账号/私有仓库
npx supabase secrets set GITHUB_WORKFLOW_TOKEN=仅允许触发workflow的细粒度令牌
```

然后部署：

```powershell
npx supabase functions deploy translate
npx supabase functions deploy daily-feed
npx supabase functions deploy change-password
npx supabase functions deploy admin-users
npx supabase functions deploy admin-reset-password
npx supabase functions deploy admin-content-run
npx supabase functions deploy admin-content-review
```

翻译路由只包含智谱、ModelScope 和明确列入 `SILICONFLOW_FREE_MODELS` 的硅基流动模型。72B 等按量型号不会因为填了密钥而自动加入。所有免费线路失败时返回 503，不会调用付费模型。

## 4. 创建第一个管理员

只在自己的电脑运行，运行完成后清除终端历史中的临时密码：

```powershell
$env:SUPABASE_URL="https://你的项目.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="你的service-role-key"
$env:SODA_ADMIN_USERNAME="admin"
node scripts/bootstrap-admin.mjs
```

脚本只显示一次随机临时密码。管理员首次登录必须改成至少 16 位、同时含大小写字母、数字和符号的新密码。改密会撤销临时密码会话，随后用新密码重新登录；之后在 `/admin` 的“内部账号”区域创建最多 6 个读者账号。

## 5. 配置 GitHub

Repository Settings → Secrets and variables → Actions 新增这些 Secrets：

- `SUPABASE_DB_URL`：Supabase Direct connection URI；使用 GitHub IPv6 不通时按 Supabase 提示改用 Session pooler。
- `ZHIPU_API_KEY`
- `MODELSCOPE_ACCESS_TOKEN`
- `SILICONFLOW_API_KEY`
- `AGE_PUBLIC_KEY`：只放 age 公钥。
- `EXPO_TOKEN`
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Variables 可设置 `ZHIPU_MODEL`、`MODELSCOPE_MODEL`、`SILICONFLOW_MODEL` 和 `CONTENT_CONTACT_EMAIL`。不要配置腾讯、阿里后付费或 DeepSeek 付费密钥。

工作流行为：

- `daily-content.yml`：每天北京时间 21:17 采集 500–2000 条候选，生成次日版。
- `encrypted-backup.yml`：每天生成 age 加密的 `pg_dump`，Artifact 保存 14 天。
- `android-internal.yml`：仅手动触发一次 APK 构建，避免浪费 EAS 次数。
- `android-update.yml`：仅 JS/样式变化时手动推送内部更新。
- `quality.yml`：构建和测试。

## 6. 部署两个 Cloudflare Pages 项目

用户站：

- Build command：`npm ci && npm run build:web`
- Output directory：`dist`
- 环境变量：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`VITE_ENABLE_ADMIN=false`

管理站：

- Build command：`npm ci && npm run build:admin`
- Output directory：`dist-admin`
- 环境变量：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`

在 Zero Trust → Access → Applications 中给管理站的 `*.pages.dev` 地址建立 Self-hosted application，只允许管理员自己的邮箱。Cloudflare Access 是第一层，数据库中的 `admin` 角色是第二层；两层都要保留。

## 7. 免费额度护栏

管理台显示四项月度计数，达到以下值变为警告：

- Supabase 数据库 400 MB。
- Edge Functions 400,000 次。
- GitHub Actions 1,600 分钟。
- EAS Android 构建 12 次。

系统的 `PAID_PROVIDER_ENABLED=false`、`DAILY_PAID_BUDGET_CNY=0` 和 `PAID_FALLBACK_MODE=never` 是硬检查。模型额度耗尽时使用文章预生成翻译、共享缓存或最近 7 天备用导读；不会自动产生费用。

## 8. 上线前内部验收

1. 匿名打开 PostgREST，确认 `profiles`、`vocabulary_items` 和文章表都返回空或 401。
2. 用两个读者账号分别创建生词，确认不能交叉读取。
3. 停用其中一个账号，确认旧 JWT 立即失去 RLS 与 Edge Function 权限。
4. 重置密码，确认旧会话失效、新登录强制改密，并且改密前 RLS 无法读取推荐或写入学习数据。
5. 手动运行一次内容工作流，确认次日 edition 不超过 12 个版本。
6. 下载一次加密备份，在临时 PostgreSQL 中做恢复演练。
7. 构建 APK，检查 APK 与网页产物中不存在 service role key、模型密钥和 GitHub token。

官方额度与限制可能变化，上线前复核 [Supabase Pricing](https://supabase.com/pricing)、[Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)、[GitHub Actions included usage](https://docs.github.com/en/billing/reference/product-usage-included) 和 [Expo pricing](https://expo.dev/pricing)。
