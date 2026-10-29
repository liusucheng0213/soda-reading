import { contextualDictionary, dailyAlternatives, demoArticle, fallbackLibrary } from "../data.js";
import { displayFeed } from "./feed.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const LOCAL_ADMIN_USERNAME = String(import.meta.env.VITE_LOCAL_ADMIN_USERNAME || "admin").trim().toLowerCase();
const LOCAL_ADMIN_PASSWORD = String(import.meta.env.VITE_LOCAL_ADMIN_PASSWORD || "");
const LOCAL_DEV_SMS_CODE = String(import.meta.env.VITE_DEV_SMS_CODE || "");
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

export async function loginWithPassword(username, password) {
  try {
    const result = await request("/auth/password/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return {
      session: {
        accessToken: result.accessToken,
        user: result.user,
      },
      profile: result.profile,
    };
  } catch (error) {
    if (!import.meta.env.DEV || !LOCAL_ADMIN_PASSWORD) throw error;
    if (username.trim().toLowerCase() !== LOCAL_ADMIN_USERNAME || password !== LOCAL_ADMIN_PASSWORD) throw error;
    return {
      session: {
        accessToken: "local-admin-session",
        user: { id: "local-admin", username: LOCAL_ADMIN_USERNAME },
      },
      profile: {
        username: LOCAL_ADMIN_USERNAME,
        role: "admin",
        level: "B1",
        topics: ["科技", "文化"],
        minutes: 10,
        reminder: "20:30",
        reviewLimit: 20,
        onboarded: true,
      },
    };
  }
}

export async function logout() {}

export async function saveProfile(profile) {
  return {
    ...profile,
    level: profile.level || "B1",
    topics: profile.topics?.length ? profile.topics.slice(0, 4) : ["文化"],
    minutes: [5, 10, 20].includes(profile.minutes) ? profile.minutes : 10,
    reminder: profile.reminder || "20:30",
  };
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
    if (!import.meta.env.DEV || !LOCAL_DEV_SMS_CODE) throw error;
    return { requestId: "local-demo", expiresIn: 300, devCode: LOCAL_DEV_SMS_CODE, provider: "local" };
  }
}

export async function verifySms(phone, code) {
  try {
    return await request("/auth/sms/verify", { method: "POST", body: JSON.stringify({ phone, code }) });
  } catch (error) {
    if (!import.meta.env.DEV || !LOCAL_DEV_SMS_CODE) throw error;
    if (code !== LOCAL_DEV_SMS_CODE) throw new Error("验证码不正确");
    return { accessToken: `demo-${phone}`, user: { id: `user-${phone.slice(-4)}`, phone } };
  }
}

export async function getDailyFeed(token, preferences = {}) {
  const query = new URLSearchParams({ level: preferences.level || "B1" });
  for (const topic of preferences.topics?.length ? preferences.topics.slice(0, 4) : ["文化"]) {
    query.append("topics", topic);
  }
  let live;
  try {
    live = await request(`/feed/daily?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 4000,
    });
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
  return request("/admin/providers", { timeout: 2400 });
}

export async function getTranslationOverview() {
  return request("/admin/translation", { timeout: 2400 });
}

export async function getSourceStatus() {
  return request("/admin/sources", { timeout: 5000 });
}

export async function getContentRuns(limit = 10) {
  return request(`/admin/content/runs?limit=${encodeURIComponent(limit)}`, { timeout: 5000 });
}

export async function getContentCandidates(limit = 30) {
  return request(`/admin/content/candidates?limit=${encodeURIComponent(limit)}`, { timeout: 5000 });
}

export async function getReviewArticles(limit = 20) {
  return request(`/admin/articles?status=review&limit=${encodeURIComponent(limit)}`, { timeout: 5000 });
}

export async function reviewArticle(articleId, decision, note = "") {
  return request(`/admin/articles/${encodeURIComponent(articleId)}/${decision}`, {
    method: "POST",
    body: JSON.stringify({ note }),
    timeout: 5000,
  });
}

export async function runContentPipeline({ limit = 8, generate = true, publish = true } = {}) {
  return request("/admin/content/run", {
    method: "POST",
    body: JSON.stringify({ limit, generate, publish }),
    timeout: 180000,
  });
}

export async function getProviderConfig() {
  return request("/admin/providers/config", { timeout: 5000 });
}

export async function saveProviderConfig(payload) {
  return request("/admin/providers/config", {
    method: "PUT",
    body: JSON.stringify(payload),
    timeout: 8000,
  });
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
        const result = await request("/translations/word", {
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
      const result = await request("/translations/sentence", {
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
