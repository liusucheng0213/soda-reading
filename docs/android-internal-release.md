# Android 内部 APK 构建与分发

## 首次配置

```powershell
npm install
cd apps/mobile
npx eas-cli login
npx eas-cli init
```

`eas init` 会写入真实 Expo `projectId`。确认 `app.json` 中不再出现 `REPLACE_WITH_EAS_PROJECT_ID`。在 EAS 项目中建立 `internal` 环境，并设置：

```text
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY
```

anon key 不是管理员密钥，它的权限完全受 RLS 约束。不要把 service role 或模型密钥放入 APK。

## 本地检查

```powershell
npm run typecheck:mobile
cd apps/mobile
npx expo export --platform android
npx expo prebuild --platform android
```

PDF 使用 `modules/soda-pdfbox` 中的 Android 原生模块，因此不能用通用 Expo Go 测试 PDF 导入；要使用 development build 或正式 APK。

## 构建内部 APK

```powershell
cd apps/mobile
npx eas-cli build --platform android --profile preview
```

也可以在 GitHub Actions 手动运行 “Android internal APK”。EAS 完成后下载 APK，计算 SHA-256，再通过可信的私聊或加密网盘把“下载地址 + 哈希值”发给熟人。不要建立公开下载页。

接收者在 Android 设置中临时允许对应文件管理器“安装未知应用”，核对哈希后安装；安装完成可关闭此权限。

## 更新规则

- 只改 JS、样式、文案或内容逻辑：运行 `eas update --channel internal`，不消耗原生构建次数。
- 改 PDFBox、Expo SDK、通知、SecureStore、SQLite 或其他原生依赖：增加 `versionCode`，重新构建 APK。
- 账号停用或密码重置不需要重新发 APK，服务端会让旧会话失权。

## APK 验收

- 登录、首次改密、退出、停用与密码重置。
- 首次改密后回到登录页，用新密码重新登录，确认临时会话已撤销。
- 断网打开已有推荐、导入书和生词复习。
- TXT、复杂 EPUB、文本 PDF、扫描 PDF 和 50 MB 限制。
- 点击词后词义在词下；点击句末后句译在句下；再次点击收起。
- 日间暖白、夜间深墨蓝、大字体、44×44 触控区域。
- `jadx` 或字符串扫描中不存在 service role、模型密钥、GitHub token 和数据库密码。
