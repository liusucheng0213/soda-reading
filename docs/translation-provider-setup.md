# 翻译提供方申请与配置

> 默认模型名以 `backend/app/settings.py` 为准。平台价格、免费额度、模型可用性和限流会变化，使用前请核对官方页面；本文不承诺免费额度或生产 SLA。

## 默认路由与费用边界

词译默认路由是 **DeepSeek**，默认模型是 `deepseek-chat`。DeepSeek 可能计费，因此只保存 API Key 不会让它立即可用。默认配置为：

```dotenv
PAID_PROVIDER_ENABLED=false
DAILY_PAID_BUDGET_CNY=0
PAID_FALLBACK_MODE=never
```

在这个默认配置下，所有 `may_charge=True` 的线路都会被阻断，包括 DeepSeek、标记为 `cheapApi` 的线路、自定义 OpenAI 兼容线路、未确认免费额度保护的腾讯线路、百炼和可能计费的硅基流动模型。`cheapApi` 只是配置元数据，不是免费或预算豁免。

如果明确接受当前阅读端可能产生费用，可以在 `backend/.env` 同时设置：

```dotenv
PAID_PROVIDER_ENABLED=true
DAILY_PAID_BUDGET_CNY=5
PAID_REQUEST_MAX_CNY=0.02
PAID_FALLBACK_MODE=automatic
```

`automatic` 是管理员显式允许付费路由的模式，当前阅读端发出的 `qualityMode=free` 请求也可在预算内使用该路由。`manual` 只允许 `qualityMode=precise` 的请求；当前阅读端固定发送 `free`，所以不要在希望阅读端使用 DeepSeek 时选择 `manual`。`never` 始终禁止付费路由。

每日预算和单次上限使用进程内保守估算与预留，不是供应商账单，也不能替代平台控制台的消费上限和告警。后端重启会重置内存中的预留记录。内容生成也检查同一组付费开关和预算；长文生成的估算费用如果超过单次上限，会被拒绝而不是绕过限制。

## 1. DeepSeek：默认提供方

官方入口：

- [DeepSeek 开放平台](https://platform.deepseek.com/)
- [创建 API Key](https://platform.deepseek.com/api_keys)

在 `backend/.env` 填写：

```dotenv
DEEPSEEK_API_KEY=复制的APIKey
DEEPSEEK_MODEL=deepseek-chat
TRANSLATION_PROVIDER_ORDER=deepseek
PAID_PROVIDER_ENABLED=true
DAILY_PAID_BUDGET_CNY=5
PAID_REQUEST_MAX_CNY=0.02
PAID_FALLBACK_MODE=automatic
```

接口地址使用 `https://api.deepseek.com`，不要添加 `/v1`。如果不需要付费调用，保持默认付费开关和零预算即可；DeepSeek 不会被请求。

## 2. 智谱 GLM：可选

官方入口：

- [GLM-4.7-Flash 说明](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash)
- [创建 API Key](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)
- [API 调用说明](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)
- [速率限制](https://docs.bigmodel.cn/cn/api/rate-limit)

```dotenv
ZHIPU_API_KEY=复制的APIKey
ZHIPU_MODEL=glm-4.7-flash
```

这是可选线路，不是默认首选。更换模型时应重新核对计费方式；不要仅凭模型名中的 `flash` 推断永远免费。

## 3. 魔搭 ModelScope：可选

官方入口：

- [ModelScope 首页](https://modelscope.cn/)
- [创建 Access Token](https://modelscope.cn/my/myaccesstoken)
- [API-Inference 使用说明](https://modelscope.cn/docs/model-service/API-Inference/intro)
- [额度与限流](https://modelscope.cn/docs/model-service/API-Inference/limits)

```dotenv
MODELSCOPE_ACCESS_TOKEN=复制的Token
MODELSCOPE_MODEL=Qwen/Qwen3.5-35B-A3B
```

在模型页确认所选模型支持 API-Inference。免费额度、并发和支持状态以平台当前说明为准。

## 4. 硅基流动：可选

官方入口：

- [注册与控制台](https://cloud.siliconflow.cn/)
- [创建 API Key](https://cloud.siliconflow.cn/account/ak)
- [模型与使用说明](https://docs.siliconflow.cn/cn/userguide/introduction)
- [限流说明](https://docs.siliconflow.cn/cn/userguide/rate-limits/rate-limit-and-upgradation)

```dotenv
SILICONFLOW_API_KEY=复制的APIKey
SILICONFLOW_MODEL=Qwen/Qwen2.5-7B-Instruct
```

在控制台核对模型价格。代码会把模型名包含 `72b` 的硅基流动线路标为可能计费；更换其他模型时仍应以平台实际计费为准。

## 5. 腾讯机器翻译：可选基础翻译

官方入口：

- [机器翻译控制台](https://console.cloud.tencent.com/tmt)
- [新手入门](https://cloud.tencent.com/document/product/551/104415)
- [SecretId / SecretKey 管理](https://console.cloud.tencent.com/cam/capi)
- [免费额度与计费](https://cloud.tencent.com/document/product/551/35017)

```dotenv
TENCENT_SECRET_ID=复制的SecretId
TENCENT_SECRET_KEY=复制的SecretKey
TENCENT_REGION=ap-guangzhou
TENCENT_FREE_QUOTA_GUARDED=false
```

只有在腾讯控制台确认免费额度和后付费保护后，才把 `TENCENT_FREE_QUOTA_GUARDED` 改为 `true`。否则该线路按可能计费处理，并受付费开关和预算阻断。腾讯线路提供基础翻译，不作为上下文词义首选。

## 6. 阿里百炼：可选

官方入口：

- [百炼控制台](https://bailian.console.aliyun.com/)
- [创建 API Key](https://help.aliyun.com/zh/model-studio/get-api-key/)
- [新人免费额度规则](https://help.aliyun.com/zh/model-studio/new-free-quota/)

```dotenv
DASHSCOPE_API_KEY=复制的APIKey
DASHSCOPE_MODEL=qwen-mt-flash
```

百炼线路始终按可能计费处理。即使账号有新人额度，也仍须显式开启付费并设置预算；额度和有效期以控制台为准。

## 自定义 OpenAI 兼容线路

管理站的「模型路由」可以添加兼容 `POST /chat/completions` 的端点。接口地址通常填到 `/v1`，模型名以供应商文档为准。自定义线路一律按 `may_charge=True` 处理，`cheapApi` 不会豁免付费开关、每日预算、单次上限或请求模式。

密钥保存在本机 `backend/data/provider_overrides.json`，该文件已忽略。不要把密钥写入前端环境变量、源码或文档。

## 路由顺序与生效

默认只有：

```dotenv
TRANSLATION_PROVIDER_ORDER=deepseek
```

如果已配置并确认使用可选线路，可以显式写成：

```dotenv
TRANSLATION_PROVIDER_ORDER=deepseek,zhipu,modelscope
```

动态路由会结合配置顺序、近期成功率和延迟排序，拥堵线路会短时熔断。保存后重启后端：

```powershell
cd backend
$env:PYTHONPATH="."
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`/admin/providers` 展示配置、阻断和运行状态，`/admin/translation` 展示缓存与付费保护；接口不会返回完整密钥。翻译记忆在后端进程内存和浏览器本地，相同并发请求会合并。
