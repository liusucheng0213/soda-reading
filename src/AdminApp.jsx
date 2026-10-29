import { useEffect, useState } from "react";
import {
  ArrowLeft,
  GearSix,
  Plus,
  ShieldCheck,
} from "@phosphor-icons/react";
import { sourcePolicies } from "./data.js";
import {
  getContentCandidates,
  getContentRuns,
  getProviderConfig,
  getProviderStatus,
  getSourceStatus,
  getTranslationOverview,
  runContentPipeline,
  saveProviderConfig,
} from "./lib/api.js";

const PROVIDER_LABELS = {
  modelscope: "魔搭 ModelScope",
  zhipu: "智谱 GLM",
  siliconflow: "硅基流动",
  tencent: "腾讯机器翻译",
  dashscope: "阿里百炼",
  deepseek: "DeepSeek",
};

const TABS = [
  { id: "sources", label: "内容来源", icon: ShieldCheck },
  { id: "models", label: "模型路由", icon: GearSix },
];

function runRatio(run) {
  if (!run) return "尚未采集";
  const fetched = run.fetchedCount ?? 0;
  const accepted = run.acceptedCount ?? 0;
  return `${accepted} / ${fetched}`;
}

const EMPTY_PROVIDER = {
  id: "",
  label: "",
  kind: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
  enabled: true,
  cheapApi: true,
  help: "兼容 OpenAI Chat Completions。接口地址填到 /v1 这一层，不要带 /chat/completions。",
};

export function AdminApp() {
  const [adminTab, setAdminTab] = useState("sources");
  const [sources, setSources] = useState(sourcePolicies);
  const [providers, setProviders] = useState([]);
  const [providerConfig, setProviderConfig] = useState(null);
  const [translationOverview, setTranslationOverview] = useState(null);
  const [runs, setRuns] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineError, setPipelineError] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelNotice, setModelNotice] = useState("");

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      getProviderStatus(),
      getTranslationOverview(),
      getSourceStatus(),
      getContentRuns(),
      getContentCandidates(),
      getProviderConfig(),
    ]).then(([
      providerResult,
      translationResult,
      sourceResult,
      runResult,
      candidateResult,
      configResult,
    ]) => {
      if (!active) return;
      setProviders(providerResult.status === "fulfilled" ? providerResult.value : []);
      setTranslationOverview(translationResult.status === "fulfilled" ? translationResult.value : null);
      if (sourceResult.status === "fulfilled") setSources(sourceResult.value);
      if (runResult.status === "fulfilled") setRuns(runResult.value);
      if (candidateResult.status === "fulfilled") setCandidates(candidateResult.value);
      if (configResult.status === "fulfilled") setProviderConfig(configResult.value);
    });
    return () => { active = false; };
  }, []);

  async function refreshContentData() {
    const [sourceResult, runResult, candidateResult] = await Promise.all([
      getSourceStatus(),
      getContentRuns(),
      getContentCandidates(),
    ]);
    setSources(sourceResult);
    setRuns(runResult);
    setCandidates(candidateResult);
  }

  async function runDiscoveryCheck() {
    setPipelineBusy(true);
    setPipelineError("");
    try {
      await runContentPipeline({ limit: 8, generate: true, publish: true });
      await refreshContentData();
    } catch (error) {
      setPipelineError(error.message || "采集失败");
    } finally {
      setPipelineBusy(false);
    }
  }

  function updateProviderDraft(index, patch) {
    setProviderConfig((current) => {
      if (!current) return current;
      const providersNext = current.providers.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      ));
      return { ...current, providers: providersNext };
    });
  }

  function addCustomProvider() {
    const suffix = String(Date.now()).slice(-6);
    setProviderConfig((current) => ({
      ...(current || { order: ["deepseek"], providers: [] }),
      providers: [
        ...(current?.providers || []),
        { ...EMPTY_PROVIDER, id: `custom-${suffix}`, label: "自定义接口" },
      ],
    }));
  }

  async function saveModels(event) {
    event.preventDefault();
    if (!providerConfig) return;
    setModelBusy(true);
    setModelNotice("");
    setPipelineError("");
    try {
      const result = await saveProviderConfig({
        order: providerConfig.order,
        providers: providerConfig.providers.map((item) => ({
          id: item.id,
          label: item.label,
          kind: item.kind || "openai",
          baseUrl: item.baseUrl,
          model: item.model,
          apiKey: item.apiKey || "",
          enabled: item.enabled !== false,
          cheapApi: item.cheapApi !== false,
          clearKey: Boolean(item.clearKey),
        })),
      });
      setProviderConfig(result.config);
      setProviders(result.providers || []);
      setModelNotice("已保存。密钥只留在本机，页面不会再显示完整 Key。");
    } catch (error) {
      setPipelineError(error.message || "模型配置保存失败");
    } finally {
      setModelBusy(false);
    }
  }

  const configuredProviders = providers.filter((provider) => provider.configured && provider.enabled).length;
  const rankedProviders = [...providers].sort(
    (left, right) => (left.routeRank ?? 99) - (right.routeRank ?? 99),
  );
  const cacheHits = translationOverview?.cache?.memoryHits ?? 0;
  const latestRun = runs[0];
  const acceptedCandidates = candidates.filter((item) => item.status === "accepted").length;
  const activeSources = sources.filter((item) => item.status === "active").length;
  const qualifiedPool = latestRun
    ? Object.values(latestRun.topicCoverage ?? {}).reduce((sum, count) => sum + count, 0)
    : acceptedCandidates;
  const titles = {
    sources: "内容来源",
    models: "模型路由",
  };

  return (
    <div className="admin-shell">
      <aside>
        <a href="/">苏打阅读</a>
        <nav>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={adminTab === id ? "active" : ""}
              onClick={() => setAdminTab(id)}
            >
              <Icon size={19} />{label}
            </button>
          ))}
        </nav>
        <a className="admin-back" href="/"><ArrowLeft size={16} />返回阅读端</a>
      </aside>
      <main>
        <header>
          <div>
            <span>CONTENT OPERATIONS</span>
            <h1>{titles[adminTab]}</h1>
          </div>
          {adminTab === "sources" && (
            <button className="admin-primary" onClick={runDiscoveryCheck} disabled={pipelineBusy}>
              <Plus size={18} />{pipelineBusy ? "采集中…" : "采集并发布"}
            </button>
          )}
        </header>
        {pipelineError && <div className="admin-alert">{pipelineError}</div>}
        {adminTab === "sources" && (
          <>
            <section className="admin-summary">
              <article><span>活跃来源</span><strong>{activeSources}</strong><small>只抓已许可、可全文的来源</small></article>
              <article><span>通过 / 抓取</span><strong>{runRatio(latestRun)}</strong><small>{latestRun ? `去重 ${latestRun.duplicateCount} · 淘汰 ${latestRun.rejectedCount}` : "等待首次采集"}</small></article>
              <article><span>已配置翻译路由</span><strong>{configuredProviders}</strong><small>{configuredProviders ? "密钥只保存在后端" : "请在「模型路由」填写 Key"}</small></article>
            </section>
            <section className="admin-panel pipeline-panel">
              <div className="admin-panel-head">
                <div>
                  <h2>采集管道</h2>
                  <p>采集=抓取许可原文；验证=自动检查版权、语言、篇幅、日期。通过后生成中文导读并发布到首页。小规模刷新大约一两分钟，不再扫完全部论文库。</p>
                </div>
                <span className={`run-state ${latestRun?.status ?? "idle"}`}>{latestRun?.status === "completed" ? "最近运行成功" : latestRun?.status === "failed" ? "最近运行失败" : latestRun?.status === "running" ? "运行中" : "尚未运行"}</span>
              </div>
              <div className="pipeline-metrics">
                <div><span>请求上限</span><strong>{latestRun?.requestedLimit ?? 0}</strong></div>
                <div><span>实际抓取</span><strong>{latestRun?.fetchedCount ?? 0}</strong></div>
                <div><span>通过初筛</span><strong>{latestRun?.acceptedCount ?? 0}</strong></div>
                <div><span>淘汰</span><strong>{latestRun?.rejectedCount ?? 0}</strong></div>
                <div><span>生成导读</span><strong>{latestRun?.generatedCount ?? 0}</strong></div>
                <div><span>已发布</span><strong>{latestRun?.publishedCount ?? 0}</strong></div>
              </div>
              <div className="coverage-row">
                {["科技", "文化", "商业", "自然", "健康", "历史"].map((topic) => (
                  <span key={topic}>{topic}<strong>{latestRun?.topicCoverage?.[topic] ?? 0}</strong></span>
                ))}
              </div>
            </section>
            <section className="admin-panel">
              <div className="admin-panel-head">
                <div><h2>来源策略</h2><p>抓取权限与全文展示权限分开管理。中文维基精选会译成控难英语后再上首页。</p></div>
                <span className="route-order">合格池 {qualifiedPool}</span>
              </div>
              <div className="source-table">
                <div className="table-row table-head"><span>来源</span><span>许可</span><span>全文</span><span>健康</span><span>状态</span></div>
                {sources.map((source) => (
                  <div className="table-row" key={source.id}>
                    <strong>{source.name}</strong>
                    <span>{source.license}</span>
                    <span>{(source.fullTextAllowed ?? source.fullText) ? "允许" : "仅索引"}</span>
                    <span>{source.health?.status === "degraded" ? "异常" : source.health?.status === "healthy" ? "正常" : "未运行"}</span>
                    <i className={`status-pill ${source.status}`}>{source.status === "active" ? "启用" : source.status === "retired" ? "停用" : "复核"}</i>
                  </div>
                ))}
              </div>
            </section>
            <section className="admin-panel">
              <div className="admin-panel-head"><div><h2>最近候选内容</h2><p>这里只展示元数据和短摘要；未获许可来源不会保存正文。</p></div><span className="route-order">{candidates.length} 条</span></div>
              <div className="candidate-table">
                {candidates.length === 0 && <p className="provider-empty">暂无采集结果，可先点「采集并发布」。</p>}
                {candidates.map((candidate) => (
                  <a href={candidate.url} target="_blank" rel="noreferrer" className="candidate-row" key={candidate.id}>
                    <div><strong>{candidate.title}</strong><small>{candidate.sourceId} · {candidate.publishedAt?.slice(0, 10)}</small></div>
                    <span>{candidate.topic}</span>
                    <span>{candidate.sourceTier} 级</span>
                    <span>{Math.round(candidate.qualityScore)} 分</span>
                    <i className={`candidate-state ${candidate.status}`}>{candidate.status === "accepted" ? "通过" : candidate.status === "review" ? "复核" : "淘汰"}</i>
                  </a>
                ))}
              </div>
            </section>
          </>
        )}
        {adminTab === "models" && (
          <section className="admin-panel">
            <div className="admin-panel-head">
              <div>
                <h2>模型路由</h2>
                <p>默认路由是 DeepSeek，但它可能计费。DeepSeek、cheapApi 和自定义线路都必须显式启用付费、设置正数每日预算与单次上限，并满足请求模式；默认零预算不会调用。密钥只保存在本机。</p>
              </div>
              <span className="route-order">{rankedProviders.filter((provider) => provider.routeRank).map((provider) => PROVIDER_LABELS[provider.provider] ?? provider.provider).join(" → ") || "等待路由状态"}</span>
            </div>
            {translationOverview && (
              <div className="translation-guard">
                <span><strong>{cacheHits}</strong> 缓存命中</span>
                <span><strong>{translationOverview.cache.coalesced}</strong> 重复请求合并</span>
                <span><strong>内存</strong> 缓存层</span>
                <span><strong>{translationOverview.costGuard.paidProvidersEnabled ? `${translationOverview.costGuard.dailyBudgetCny} 元` : "0 元"}</strong> 每日付费上限</span>
              </div>
            )}
            <div className="provider-table">
              {providers.length === 0 && <p className="provider-empty">后端未启动，暂时无法读取路由状态。</p>}
              {rankedProviders.map((provider) => (
                <div className="provider-row" key={provider.provider}>
                  <div><strong>{provider.routeRank ? `${provider.routeRank}. ` : ""}{PROVIDER_LABELS[provider.provider] ?? provider.provider}</strong><small>{provider.model} · {provider.billingClass}</small></div>
                  <span>{provider.enabled ? "动态路由" : "备用"}</span>
                  <span>{provider.averageLatencyMs == null ? "—" : `${provider.averageLatencyMs} ms`}</span>
                  <span>{provider.successes} 成功 / {provider.failures} 失败</span>
                  <i className={`provider-state ${provider.configured ? provider.status : "not_configured"}`}>{provider.configured ? (provider.status === "blocked_by_zero_budget" ? "付费护栏已阻断" : provider.status === "degraded" ? "异常" : "已配置") : "未配置"}</i>
                </div>
              ))}
            </div>
            <form className="provider-config-form" onSubmit={saveModels}>
              <div className="admin-panel-head">
                <div>
                  <h2>添加或修改接口</h2>
                  <p>填写说明：接口地址填到 /v1（DeepSeek 例外，填 https://api.deepseek.com，不要加 /v1）。模型名按供应商文档。密钥可留空以保留原值。</p>
                </div>
                <button type="button" onClick={addCustomProvider}>添加自定义接口</button>
              </div>
              <label className="provider-order-field">
                调用顺序
                <input
                  value={(providerConfig?.order || []).join(",")}
                  onChange={(event) => setProviderConfig((current) => ({
                    ...(current || { providers: [] }),
                    order: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                  }))}
                  placeholder="deepseek,zhipu"
                />
                <small>用英文逗号分隔 id，排在前面的优先。</small>
              </label>
              {(providerConfig?.providers || []).map((item, index) => (
                <fieldset className="provider-edit" key={item.id || index}>
                  <legend>{item.label || item.id}</legend>
                  <p className="provider-help">{item.help}</p>
                  <div className="provider-edit-grid">
                    <label>标识<input value={item.id} onChange={(event) => updateProviderDraft(index, { id: event.target.value.trim().toLowerCase() })} required /></label>
                    <label>显示名<input value={item.label || ""} onChange={(event) => updateProviderDraft(index, { label: event.target.value })} /></label>
                    <label>接口地址<input value={item.baseUrl || ""} onChange={(event) => updateProviderDraft(index, { baseUrl: event.target.value })} placeholder="https://api.deepseek.com" /></label>
                    <label>模型名<input value={item.model || ""} onChange={(event) => updateProviderDraft(index, { model: event.target.value })} placeholder="deepseek-chat" /></label>
                    <label>API Key<input type="password" value={item.apiKey || ""} onChange={(event) => updateProviderDraft(index, { apiKey: event.target.value, clearKey: false })} placeholder={item.maskedKey || "未填写"} autoComplete="off" /></label>
                    <label className="provider-check"><input type="checkbox" checked={item.enabled !== false} onChange={(event) => updateProviderDraft(index, { enabled: event.target.checked })} />启用</label>
                  </div>
                </fieldset>
              ))}
              {modelNotice && <p className="inline-status">{modelNotice}</p>}
              <button className="admin-primary" type="submit" disabled={modelBusy || !providerConfig}>{modelBusy ? "保存中…" : "保存模型配置"}</button>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}
