# 免费翻译 API 申请与配置

> 核对日期：2026-07-26。免费政策和可用模型可能调整，正式使用前请再次查看各平台官方页面。

## 默认调用顺序

```text
智谱 GLM-4.7-Flash 当前免费
→ 魔搭 ModelScope 每日免费
→ 硅基流动当前免费模型
→ 腾讯机器翻译每月循环免费
→ 阿里百炼新用户限时免费
```

智谱当前被官方列为免费模型且翻译能力较好，因此初始置于首位；“免费”不代表无限并发、
没有平台过载或生产 SLA。运行后路由会按质量、近期成功率和延迟动态排序，拥堵线路会进入
短时熔断。腾讯机器翻译只返回基础翻译，不作为上下文词义首选。阿里百炼位于最后，避免
在有长期或循环免费额度时提前消耗 90 天新人额度。

## 1. 智谱 GLM-4.7-Flash：当前免费，优先申请

官方入口：

- [GLM-4.7-Flash 免费模型说明](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash)
- [创建 API Key](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)
- [API 调用说明](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)
- [速率限制说明](https://docs.bigmodel.cn/cn/api/rate-limit)

申请步骤：

1. 注册并登录智谱开放平台，按平台要求完成认证。
2. 打开 API Key 管理页，创建一个项目用 API Key。
3. 在 `backend/.env` 填写：

```dotenv
ZHIPU_API_KEY=复制的APIKey
ZHIPU_MODEL=glm-4.7-flash
```

`glm-4.7-flash` 当前由官方列为免费模型并适合翻译。官方同时明确说明 API 会按用户权益和
模型限制并发，高峰期可能出现账户限流或平台过载，所以后面仍然需要保留自动降级路由。

## 2. 魔搭 ModelScope：每日免费

官方入口：

- [ModelScope 首页与注册](https://modelscope.cn/)
- [创建 Access Token](https://modelscope.cn/my/myaccesstoken)
- [API-Inference 使用说明](https://modelscope.cn/docs/model-service/API-Inference/intro)
- [每日额度与限流](https://modelscope.cn/docs/model-service/API-Inference/limits)

申请步骤：

1. 注册并登录 ModelScope。
2. 按平台提示绑定阿里云账号并完成实名认证。API-Inference 要求完成这两步。
3. 打开“我的 Access Token”，创建 Token，并立即复制到安全位置。
4. 在 ModelScope 模型页确认所选模型当前支持 API-Inference；支持状态和模型名以模型页为准。
5. 在 `backend/.env` 填写：

```dotenv
MODELSCOPE_ACCESS_TOKEN=复制的Token
MODELSCOPE_MODEL=Qwen/Qwen3.5-35B-A3B
```

官方明确说明 API-Inference 免费额度、并发和具体模型状态会按资源情况动态调整。该免费
服务适合开发和低并发 MVP，不承诺生产 SLA；正式商用前应切换到有 SLA 的服务或保留稳定
机器翻译兜底。

## 3. 硅基流动：当前免费模型

官方入口：

- [注册与控制台](https://cloud.siliconflow.cn/)
- [创建 API Key](https://cloud.siliconflow.cn/account/ak)
- [免费模型说明](https://docs.siliconflow.cn/cn/userguide/introduction)
- [实名认证说明](https://docs.siliconflow.cn/cn/faqs/authentication)
- [免费模型限流](https://docs.siliconflow.cn/cn/userguide/rate-limits/rate-limit-and-upgradation)

申请步骤：

1. 注册硅基流动并完成实名认证；免费模型调用需要实名认证。
2. 打开 API Key 页面，创建并复制密钥。
3. 在控制台确认模型名称带有“免费”标记。不要把模型改成带 `Pro/` 前缀的付费版本。
4. 在 `backend/.env` 填写：

```dotenv
SILICONFLOW_API_KEY=复制的APIKey
SILICONFLOW_MODEL=Qwen/Qwen2.5-7B-Instruct
```

免费模型当前调用费用为 0，但有固定限流，平台也可能调整免费模型清单。

## 4. 腾讯机器翻译：每月循环免费兜底

官方入口：

- [机器翻译控制台](https://console.cloud.tencent.com/tmt)
- [新手入门](https://cloud.tencent.com/document/product/551/104415)
- [SecretId / SecretKey 管理](https://console.cloud.tencent.com/cam/capi)
- [免费额度与计费](https://cloud.tencent.com/document/product/551/35017)

申请步骤：

1. 注册腾讯云并完成实名认证。
2. 打开机器翻译控制台，启用“文本翻译”，确认免费资源包已经发放。
3. 保持“后付费”关闭。这样免费额度用完后会停止调用，不会自动扣费。
4. 打开访问密钥管理页创建密钥。`SecretKey` 通常只在创建时完整显示一次，请立即保存。
5. 在 `backend/.env` 填写：

```dotenv
TENCENT_SECRET_ID=复制的SecretId
TENCENT_SECRET_KEY=复制的SecretKey
TENCENT_REGION=ap-guangzhou
TENCENT_FREE_QUOTA_GUARDED=true
```

当前文本翻译免费额度为每月 500 万字符，并按月循环发放。它不是大模型上下文翻译，
因此苏打阅读只把它用于 `basic` 基础词义或句译兜底。只有在你已确认腾讯控制台关闭
后付费后，才把 `TENCENT_FREE_QUOTA_GUARDED` 设为 `true`；否则代码会把腾讯视为可能
扣费的路由并在零预算模式下阻断。

## 5. 阿里百炼：90 天新人额度，最后使用

官方入口：

- [百炼控制台](https://bailian.console.aliyun.com/)
- [创建 API Key](https://help.aliyun.com/zh/model-studio/get-api-key/)
- [新人免费额度规则](https://help.aliyun.com/zh/model-studio/new-free-quota/)

申请步骤：

1. 注册阿里云并完成实名认证，进入百炼控制台，选择中国内地“北京”地域。
2. 开通模型服务，创建普通按量付费 API Key。不要使用 Coding Plan 或 Token Plan 专用 Key。
3. 在额度管理中为可用模型打开“免费额度用完即停”。
4. 在 `backend/.env` 填写：

```dotenv
DASHSCOPE_API_KEY=复制的APIKey
DASHSCOPE_MODEL=qwen-mt-flash
```

中国内地新用户的免费额度通常只有 90 天，且不同模型额度分别计算，所以它位于免费
路由末尾。90 天结束或额度耗尽后，应禁用该路由或确认计费设置。

## 写入项目并生效

在项目根目录执行：

```powershell
if (-not (Test-Path backend\.env)) { Copy-Item backend\.env.example backend\.env }
notepad backend\.env
```

最少先申请智谱；为提高成功率，建议再配置 ModelScope 和硅基流动。最终顺序保持：

```dotenv
TRANSLATION_PROVIDER_ORDER=zhipu,modelscope,siliconflow,tencent,dashscope
```

保存后重启后端：

```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

打开 `http://127.0.0.1:8000/admin/providers` 可以查看每个平台是否已配置、近期成功率和
限流状态；`http://127.0.0.1:8000/admin/translation` 会显示缓存命中、重复请求合并和
付费保护状态。两个接口都不会返回密钥。

## 速度与费用保护

推荐同时配置 Redis，让缓存跨进程和重启复用：

```dotenv
REDIS_URL=redis://127.0.0.1:6379/2
TRANSLATION_CACHE_TTL_SECONDS=2592000
TRANSLATION_DYNAMIC_ROUTING=true
```

同一上下文只调用一次；并发的相同请求会合并，成功结果先写内存再写 Redis。默认请求使用
`qualityMode=free`，会阻断常规付费兜底，但 DeepSeek 及被标记为 `cheap_api` 的自定义低价
API 属于例外，配置后仍可能参与路由并产生费用。要求完全零费用时，不要配置这些密钥，
并把它们从翻译与导读路由中移除。若未来确实要启用其他付费兜底，需要同时设置非零预算、
单次上限和回退模式：

```dotenv
PAID_PROVIDER_ENABLED=true
DAILY_PAID_BUDGET_CNY=5
PAID_REQUEST_MAX_CNY=0.02
PAID_FALLBACK_MODE=manual
```

`manual` 只允许用户明确选择“精确翻译”时调用付费路由；`never` 是默认值。不要在没有
Redis、用量告警和控制台扣费上限时开启 `automatic`。

不要把密钥粘贴到聊天、前端 `.env`、`src/` 或浏览器代码中。密钥只能保存在
`backend/.env` 或部署服务器的后端环境变量中。
