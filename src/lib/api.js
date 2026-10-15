import { contextualDictionary, dailyAlternatives, demoArticle, fallbackLibrary } from "../data.js";
import { cloudClient, cloudConfigured, loginCloud, logoutCloud, restoreCloudSession } from "./cloud.js";
import { displayFeed } from "./feed.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const translationMemoryCache = new Map();
const inflightTranslations = new Map();
const TRANSLATION_MEMORY_LIMIT = 400;
const TRANSLATION_MEMORY_KEY = "soda.translationMemory";

function loadTranslationMemory() {
  try {
    const raw = globalThis.localStorage?.getItem(TRANSLATION_MEMORY_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    for (const [key, value] of entries.slice(-TRANSLATION_MEMORY_LIMIT)) {
      if (typeof key === "string" && value?.translation) translationMemoryCache.set(key, value);
    }
  } catch {
    /* private mode or quota */
  }
}

function persistTranslationMemory() {
  try {
    globalThis.localStorage?.setItem(
      TRANSLATION_MEMORY_KEY,
      JSON.stringify([...translationMemoryCache.entries()]),
    );
  } catch {
    /* quota */
  }
}

loadTranslationMemory();

function translationKey(scope, payload) {
  const sentence = payload.sentence?.replace(/\s+/g, " ").trim() ?? "";
  const contentHash = payload.contentHash ?? "";
  if (scope === "word") {
    return JSON.stringify({
      scope,
      word: payload.word?.toLowerCase() ?? "",
      sentence,
      contentHash,
    });
  }
  return JSON.stringify({ scope, sentence, contentHash });
}

export function peekWordTranslation(payload) {
  const remembered = translationMemoryCache.get(translationKey("word", payload));
  return remembered ? { ...remembered, cached: true, cacheLayer: "client", latencyMs: 0 } : null;
}

export function clearTranslationMemory() {
  translationMemoryCache.clear();
  inflightTranslations.clear();
}

function abortIfSignaled(signal) {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
}

function followTranslation(task, signal) {
  abortIfSignaled(signal);
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Request cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function rememberTranslation(key, value) {
  translationMemoryCache.set(key, value);
  if (translationMemoryCache.size > TRANSLATION_MEMORY_LIMIT) {
    translationMemoryCache.delete(translationMemoryCache.keys().next().value);
  }
  persistTranslationMemory();
}

export class ApiError extends Error {
  constructor(message, { code = "REQUEST_FAILED", status = 0, retryable = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export { cloudConfigured };

export async function restoreSession() {
  return await restoreCloudSession();
}

export async function loginWithPassword(username, password) {
  if (cloudConfigured) return await loginCloud(username, password);
  try {
    const result = await request("/auth/password/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return {
      session: {
        accessToken: result.accessToken,
        user: result.user,
        cloud: false,
      },
      profile: result.profile,
    };
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
    if (username !== "admin" || password !== "Soda-local-2026!") throw error;
    return {
      session: {
        accessToken: "local-admin-session",
        user: { id: "local-admin", username: "admin" },
        cloud: false,
      },
      profile: {
        username: "admin",
        role: "admin",
        level: "B1",
        topics: ["科技", "文化"],
        minutes: 10,
        reminder: "20:30",
        reviewLimit: 20,
        mustChangePassword: false,
        onboarded: true,
      },
    };
  }
}

export async function logout() {
  await logoutCloud();
}

export async function changePassword(password) {
  if (!cloudClient) return { changed: true };
  return await cloudClient.changePassword(password);
}

export async function saveProfile(profile, token) {
  const payload = {
    level: profile.level || "B1",
    topics: profile.topics?.length ? profile.topics.slice(0, 4) : ["文化"],
    minutes: [5, 10, 20].includes(profile.minutes) ? profile.minutes : 10,
    reminder: profile.reminder || "20:30",
  };
  if (cloudClient) {
    const saved = await cloudClient.savePreferences({ ...profile, ...payload });
    return { ...profile, ...saved };
  }
  if (!token || String(token).startsWith("local-") || String(token).startsWith("demo-")) {
    return { ...profile, ...payload };
  }
  try {
    const saved = await request("/profile/preferences", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      timeout: 4000,
    });
    return { ...profile, ...saved };
  } catch {
    return { ...profile, ...payload };
  }
}

export async function loadSyncedVocabulary() {
  if (!cloudClient) return null;
  return await cloudClient.loadVocabulary();
}

export async function loadSyncedProgress() {
  if (!cloudClient) return null;
  return await cloudClient.loadProgress();
}

export async function saveSyncedVocabulary(item) {
  if (!cloudClient) return null;
  return await cloudClient.saveVocabulary(item);
}

export async function deleteSyncedVocabulary(item) {
  if (!cloudClient || !item.remoteId) return;
  await cloudClient.deleteVocabulary(item.remoteId);
}

export async function reviewSyncedVocabulary(item, rating) {
  if (!cloudClient) return null;
  return await cloudClient.reviewVocabulary(item, rating);
}

export async function saveSyncedProgress(payload) {
  if (!cloudClient) return null;
  return await cloudClient.saveProgress(payload);
}

async function request(path, options = {}) {
  const {
    timeout = 3200,
    signal: externalSignal,
    headers,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeout);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload.detail === "object" ? payload.detail : {};
      throw new ApiError(
        detail.message || (typeof payload.detail === "string" ? payload.detail : `请求失败（${response.status}）`),
        {
          code: detail.code || `HTTP_${response.status}`,
          status: response.status,
          retryable: Boolean(detail.retryable || response.status >= 500),
        },
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (externalSignal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const translation = path.startsWith("/translations/");
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new ApiError(translation ? "翻译请求超时，请重试" : "请求超时，请重试", {
        code: "REQUEST_TIMEOUT",
        retryable: true,
      });
    }
    throw new ApiError(translation ? "无法连接翻译服务，请检查后端是否已启动" : "无法连接服务，请检查后端是否已启动", {
      code: "NETWORK_ERROR",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

export async function sendSms(phone) {
  try {
    return await request("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
    return { requestId: "local-demo", expiresIn: 300, devCode: "246810", provider: "local" };
  }
}

export async function verifySms(phone, code) {
  try {
    return await request("/auth/sms/verify", { method: "POST", body: JSON.stringify({ phone, code }) });
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
    if (code !== "246810") throw new Error("验证码不正确");
    return { accessToken: `demo-${phone}`, user: { id: `user-${phone.slice(-4)}`, phone } };
  }
}

export async function getDailyFeed(token, preferences = {}) {
  let live;
  try {
    if (cloudClient) live = await cloudClient.dailyFeed();
    else {
      live = await request("/feed/daily", {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 4000,
      });
    }
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
    live = {
      primary: demoArticle,
      alternatives: dailyAlternatives,
      generatedAt: new Date().toISOString(),
      fallback: true,
    };
  }
  return {
    ...live,
    ...displayFeed(live, preferences, fallbackLibrary),
  };
}

export async function getProviderStatus() {
  if (cloudClient) {
    const { data, error } = await cloudClient.raw.from("provider_health")
      .select("*").order("quality_score", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((item, index) => ({
      provider: item.provider,
      model: item.model,
      configured: item.enabled,
      enabled: item.enabled,
      billingClass: item.free_only ? "free-only" : "blocked",
      routeRank: item.enabled ? index + 1 : null,
      averageLatencyMs: item.p95_latency_ms,
      successes: item.success_count,
      failures: item.failure_count,
      status: item.circuit_open_until && new Date(item.circuit_open_until) > new Date()
        ? "degraded"
        : "healthy",
    }));
  }
  return request("/admin/providers", { timeout: 2400 });
}

export async function getTranslationOverview() {
  if (cloudClient) {
    const [{ count: cacheCount }, { data: usage }] = await Promise.all([
      cloudClient.raw.from("translation_cache").select("*", { count: "exact", head: true }),
      cloudClient.raw.from("daily_usage").select("translation_requests,cache_hits"),
    ]);
    return {
      cache: {
        memoryHits: (usage ?? []).reduce((sum, row) => sum + Number(row.cache_hits ?? 0), 0),
        redisHits: 0,
        coalesced: 0,
        redisConfigured: false,
        entries: cacheCount ?? 0,
      },
      costGuard: { paidProvidersEnabled: false, dailyBudgetCny: 0 },
    };
  }
  return request("/admin/translation", { timeout: 2400 });
}

export async function getQuotaStatus() {
  if (!cloudClient) {
    return {
      databaseBytes: 0,
      edgeInvocations: 0,
      githubMinutes: 0,
      easBuilds: 0,
      databaseWarning: false,
      edgeWarning: false,
      githubWarning: false,
      easWarning: false,
    };
  }
  const { data, error } = await cloudClient.raw.rpc("internal_quota_status");
  if (error) throw error;
  return data;
}

export async function getSourceStatus() {
  if (cloudClient) {
    const { data, error } = await cloudClient.raw.from("source_policies")
      .select("*,source_fetch_states(*)").order("source_tier").order("name");
    if (error) throw error;
    return (data ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      license: item.license,
      fullTextAllowed: item.full_text_allowed,
      status: item.status,
      sourceTier: item.source_tier,
      health: {
        status: item.source_fetch_states?.[0]?.consecutive_failures
          ? "degraded"
          : item.source_fetch_states?.length ? "healthy" : "not_run",
      },
    }));
  }
  return request("/admin/sources", { timeout: 5000 });
}

export async function getContentRuns(limit = 10) {
  if (cloudClient) {
    const { data, error } = await cloudClient.raw.from("pipeline_runs")
      .select("*").order("started_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      requestedLimit: item.requested_limit,
      fetchedCount: item.fetched_count,
      acceptedCount: item.accepted_count,
      duplicateCount: item.duplicate_count,
      rejectedCount: item.rejected_count,
      generatedCount: item.generated_count,
      publishedCount: item.published_count,
      sourceStats: item.source_stats,
      topicCoverage: item.topic_coverage,
      error: item.error,
      startedAt: item.started_at,
      finishedAt: item.finished_at,
    }));
  }
  return request(`/admin/content/runs?limit=${encodeURIComponent(limit)}`, { timeout: 5000 });
}

export async function getContentCandidates(limit = 30) {
  if (cloudClient) {
    const { data, error } = await cloudClient.raw.from("content_candidates")
      .select("*").order("fetched_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      url: item.canonical_url,
      sourceId: item.source_id,
      publishedAt: item.source_published_at,
      topic: item.topic,
      sourceTier: item.source_tier,
      qualityScore: item.quality_score,
      status: item.status,
    }));
  }
  return request(`/admin/content/candidates?limit=${encodeURIComponent(limit)}`, { timeout: 5000 });
}

export async function getReviewArticles(limit = 20) {
  if (cloudClient) {
    const { data, error } = await cloudClient.raw.from("article_variants")
      .select("*").eq("review_status", "review")
      .order("quality_score", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      topic: item.topic,
      cefr: item.cefr,
      qualityScore: item.quality_score,
      riskFlags: item.risk_flags ?? [],
    }));
  }
  return request(`/admin/articles?status=review&limit=${encodeURIComponent(limit)}`, { timeout: 5000 });
}

export async function reviewArticle(articleId, decision, note = "") {
  if (cloudClient) {
    const { data, error } = await cloudClient.raw.functions.invoke("admin-content-review", {
      body: { articleId, decision, note },
    });
    if (error) throw error;
    return data;
  }
  return request(`/admin/articles/${encodeURIComponent(articleId)}/${decision}`, {
    method: "POST",
    body: JSON.stringify({ note }),
    timeout: 5000,
  });
}

export async function runContentPipeline({ limit = 8, generate = true, publish = true } = {}) {
  if (cloudClient) return await cloudClient.admin.runContent(Math.max(500, limit));
  return request("/admin/content/run", {
    method: "POST",
    body: JSON.stringify({ limit, generate, publish }),
    timeout: 180000,
  });
}

export async function getProviderConfig() {
  if (cloudClient) return { presets: [], order: [], providers: [] };
  return request("/admin/providers/config", { timeout: 5000 });
}

export async function saveProviderConfig(payload) {
  if (cloudClient) throw new ApiError("云端尚未支持自定义模型配置");
  return request("/admin/providers/config", {
    method: "PUT",
    body: JSON.stringify(payload),
    timeout: 8000,
  });
}

export async function getAdminUsers() {
  if (!cloudClient) return { users: [] };
  return await cloudClient.admin.listUsers();
}

export async function createAdminUser(payload) {
  if (!cloudClient) {
    throw new ApiError("请先配置 Supabase 后再创建内部账号", { code: "CLOUD_NOT_CONFIGURED" });
  }
  return await cloudClient.admin.createUser(payload);
}

export async function resetAdminUserPassword(userId) {
  if (!cloudClient) throw new ApiError("云端尚未配置");
  return await cloudClient.admin.resetPassword(userId);
}

export async function setAdminUserStatus(userId, active) {
  if (!cloudClient) throw new ApiError("云端尚未配置");
  return await cloudClient.admin.setUserStatus(userId, active);
}

export async function revokeAdminUserSessions(userId) {
  if (!cloudClient) throw new ApiError("云端尚未配置");
  return await cloudClient.admin.revokeSessions(userId);
}

export async function translateWord({ word, sentence, before = "", after = "", contentHash = "", signal }) {
  const key = translationKey("word", { word, sentence, contentHash });
  const remembered = translationMemoryCache.get(key);
  if (remembered) return { ...remembered, cached: true, cacheLayer: "client", latencyMs: 0 };
  let task = inflightTranslations.get(key);
  if (!task) {
    task = (async () => {
      try {
        const payload = {
          word,
          sentence,
          before,
          after,
          contentHash,
          scope: "word",
          qualityMode: "free",
          targetLanguage: "zh-CN",
        };
        const result = cloudClient
          ? await cloudClient.translate(payload)
          : await request("/translations/word", {
            method: "POST",
            body: JSON.stringify(payload),
            timeout: 18000,
          });
        rememberTranslation(key, result);
        return result;
      } catch (error) {
        const normalized = word.toLowerCase();
        const entry = contextualDictionary[normalized];
        if (entry) {
          return {
            scope: "word",
            quality: "basic",
            ...entry,
            provider: "local-corpus",
            model: "dictionary",
            cached: false,
            latencyMs: 0,
          };
        }
        throw error;
      }
    })().finally(() => inflightTranslations.delete(key));
    inflightTranslations.set(key, task);
  }
  return followTranslation(task, signal);
}

export async function translateSentence({ sentence, article, before = "", after = "", contentHash = "", signal }) {
  const key = translationKey("sentence", { sentence, contentHash });
  const remembered = translationMemoryCache.get(key);
  if (remembered) return { ...remembered, cached: true, cacheLayer: "client", latencyMs: 0 };
  const translation = article?.sentenceTranslations?.[sentence];
  if (translation) {
    const result = {
      scope: "sentence",
      quality: "contextual",
      translation,
      provider: "soda-pregenerated",
      model: "article-edition",
      cached: true,
      cacheLayer: "article",
      latencyMs: 0,
      providerLatencyMs: 0,
    };
    rememberTranslation(key, result);
    return result;
  }
  let task = inflightTranslations.get(key);
  if (!task) {
    task = (async () => {
      const payload = {
        sentence,
        before,
        after,
        contentHash,
        scope: "sentence",
        qualityMode: "free",
        targetLanguage: "zh-CN",
      };
      const result = cloudClient
        ? await cloudClient.translate(payload)
        : await request("/translations/sentence", {
          method: "POST",
          body: JSON.stringify(payload),
          timeout: 18000,
        });
      rememberTranslation(key, result);
      return result;
    })().finally(() => inflightTranslations.delete(key));
    inflightTranslations.set(key, task);
  }
  return followTranslation(task, signal);
}
