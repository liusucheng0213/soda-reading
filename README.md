# 苏打阅读

面向中文读者的英语沉浸阅读工具：点词看行间中文，点句看译文，并可听读、划线、复习生词。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Language](https://img.shields.io/badge/language-JavaScript%20%7C%20Python-3178c6.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Web-111111.svg)](https://github.com/liusucheng0213/soda-reading)

网页使用 Vite + React，翻译和采集走本机 FastAPI。进度、生词、划线和偏好留在浏览器里。产品细节见 [docs/project-overview.md](docs/project-overview.md)。

## 体验路径

1. 打开今日，在 A2 / B1 / B2 / C1 之间切换，主文章会换成有正文的那一篇。
2. 进入正文，点一个词，中文语境义出现在词的正下方，不挡住下一行。
3. 点句末标点，整句中文插在该句下面；再点一次收起。
4. 打开朗读，可以暂停、再读本句、从此句朗读，并把正在听的句子划出来。

## 核心功能

- 按 CEFR 切换今日文章，并显示中文导读。
- 点词行间注、点句整句译文；代词只显示文中指代。
- 全文朗读、句级跟读、慢/常/快、查找、复制原句、剩余分钟。
- 划线、生词本和 FSRS 复习；生词里的「原文」回到当时那一句。
- 书架包含编辑目录，以及浏览器内导入的 EPUB、TXT 和文本型 PDF。
- 管理端配置采集、自动验证和翻译模型路由。密钥留在本机。

## 架构

数据在浏览器、本机 API 和可选的翻译服务之间流动。

```mermaid
flowchart LR
  browser["浏览器阅读端 Vite + React"]
  storage["localStorage 进度 生词 划线 偏好"]
  api["本机 FastAPI"]
  db["SQLite backend/data"]
  providers["翻译接口 DeepSeek 等"]
  sources["许可原文 RSS 官方 API 维基"]

  browser --> storage
  browser -->|"查词 登录 今日源"| api
  api --> db
  api --> providers
  api --> sources
```

## 本地数据与离线边界

开发服务器在后端未启动时，可以使用已配置的本地开发登录回退和内置文章；该回退只在 `import.meta.env.DEV` 下生效。生产构建的登录和在线今日源需要 FastAPI，静态预览不是无后端登录模式。

没填翻译密钥时，查词会失败，或只显示有限的本地语料。阅读进度、生词、划线、偏好和翻译记忆仍写在浏览器里。阅读交互在 `src/screens/ReaderScreen.jsx`，分词、句切分和复习在 `packages/core`。

## 运行依赖

| 组件 | 说明 |
| --- | --- |
| 桌面浏览器 | 阅读、朗读（Web Speech API）、本地存储 |
| Node.js 22 | 网页开发与测试，与 CI 一致 |
| Python 3.11 | 本机 API，与 CI 一致 |
| 翻译平台账号 | 可选。默认路由是 DeepSeek，但默认付费护栏会阻断它；见 [配置指南](docs/translation-provider-setup.md) |

## 快速开始

在仓库根目录安装锁定版本的前端依赖，并创建 Python 虚拟环境：

```powershell
npm ci
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Copy-Item .env.example .env
Copy-Item backend\.env.example backend\.env
```

在两个 `.env` 里填写同一组本地口令。不要复用旧源码或旧提交里的演示口令。数值型配置保持注释，不要写成空值。

只填写 `DEEPSEEK_API_KEY` 不会启用付费调用。DeepSeek、cheapApi 和自定义计费线路都需要显式付费开关、正数每日预算和单次上限；默认配置为零预算阻断。当前阅读端的启用示例见 [翻译配置指南](docs/translation-provider-setup.md)。

启动网页开发服务器：

```powershell
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

另开一个终端启动 API：

```powershell
cd backend
$env:PYTHONPATH="."
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

在仓库根目录检查前端和两个构建；`build:admin` 会额外断言产物不含阅读端登录与阅读控件：

```powershell
npm test
npm run build:web
npm run build:admin
```

后端检查：

```powershell
cd backend
$env:PYTHONPATH="."
..\.venv\Scripts\python.exe -m pytest -q
```

## 本地运行注意事项

1. 在仓库根目录启动 uvicorn 时，`backend/.env` 和 SQLite 相对路径会对不上。API 要在 `backend` 目录启动。
2. 前端端口不在 `ALLOWED_ORIGINS` 里时，浏览器会拦住接口。默认允许 `4173` 端口的 localhost 与 127.0.0.1。
3. `APP_ENV=development` 时，管理接口不校验 `ADMIN_API_TOKEN`；其他环境必须配置它。
4. 朗读依赖浏览器 Web Speech API。暂停会停住当前句并记住位置，而不是依赖浏览器不一致的 `pause()` 行为。
5. 扫描版 PDF 没有文字层，导入不会做文字识别。
6. 采集维基前应填写 `CONTENT_CONTACT_EMAIL`，否则请求不带联系邮箱。
7. Vite 开发服务器的 `host` 是 `0.0.0.0`，同一局域网里的设备可以访问开发页；公开启动命令已用 `--host 127.0.0.1` 收窄。

## 大文件

仓库不附带模型权重或数据集，翻译由外部 API 完成，没有需要从 Release 或网盘另下的权重包。

`backend/data/`、`.npm-cache/`、`dist/` 和 `dist-admin/` 已忽略。阅读页视觉基准 `reference-reader.png` 在仓库内，约 1.6MB。

## 许可

项目代码采用 [MIT](LICENSE)。随依赖分发的字体遵循各自的 SIL Open Font License，不把整仓改成字体许可证。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/` | 阅读端与管理端界面 |
| `packages/core/` | 分词、句切分、朗读进度、复习 |
| `backend/` | 本机翻译与内容接口 |
| `docs/` | 产品说明、翻译密钥、内容管道 |
| `AGENTS.md` | 给后续修改用的产品约束 |
