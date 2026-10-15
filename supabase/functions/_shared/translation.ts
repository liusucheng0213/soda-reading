import type { SupabaseClient } from "@supabase/supabase-js";

export type TranslationInput = {
  scope: "word" | "sentence";
  word?: string;
  sentence: string;
  before?: string;
  after?: string;
  contentHash?: string;
  qualityMode?: "free";
};

type Provider = {
  name: "zhipu" | "modelscope" | "siliconflow";
  endpoint: string;
  model: string;
  key: string;
  enabled: boolean;
};

type ProviderHealth = {
  provider: string;
  quality_score: number;
  recent_success_rate: number;
  p95_latency_ms: number;
  circuit_open_until: string | null;
};

const PROMPT_VERSION = "word-referent-v6";
const PLACEHOLDERS = new Set(["语境释义", "中文释义", "翻译", "未知", ""]);
const BARE_PRONOUN_GLOSSES = new Set(["它", "它们", "这些", "那些", "这个", "那个", "他", "她", "其"]);

function normalized(value = ""): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function canonicalHash(input: TranslationInput): Promise<string> {
  return await sha256(JSON.stringify({
    scope: input.scope,
    word: normalized(input.word).toLowerCase(),
    sentence: normalized(input.sentence),
    before: normalized(input.before),
    after: normalized(input.after),
    contentHash: input.contentHash ?? "",
    promptVersion: PROMPT_VERSION,
  }));
}

function configuredProviders(): Provider[] {
  const allowedSiliconModels = new Set(
    (Deno.env.get("SILICONFLOW_FREE_MODELS") ??
      "Qwen/Qwen2.5-7B-Instruct")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const siliconModel = Deno.env.get("SILICONFLOW_MODEL") ??
    "Qwen/Qwen2.5-7B-Instruct";
  const definitions: Provider[] = [
    {
      name: "zhipu",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: Deno.env.get("ZHIPU_MODEL") ?? "glm-4.7-flash",
      key: Deno.env.get("ZHIPU_API_KEY") ?? "",
      enabled: true,
    },
    {
      name: "modelscope",
      endpoint: "https://api-inference.modelscope.cn/v1/chat/completions",
      model: Deno.env.get("MODELSCOPE_MODEL") ?? "Qwen/Qwen3.5-35B-A3B",
      key: Deno.env.get("MODELSCOPE_ACCESS_TOKEN") ?? "",
      enabled: true,
    },
    {
      name: "siliconflow",
      endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      model: siliconModel,
      key: Deno.env.get("SILICONFLOW_API_KEY") ?? "",
      enabled: allowedSiliconModels.has(siliconModel),
    },
  ];
  return definitions.filter((provider) => provider.key && provider.enabled);
}

function providerScore(provider: Provider, health?: ProviderHealth): number {
  const quality = health?.quality_score ?? (
    provider.name === "zhipu" ? 0.9 : provider.name === "modelscope" ? 0.88 : 0.75
  );
  const success = health?.recent_success_rate ?? 1;
  const latency = health?.p95_latency_ms ?? 1800;
  const latencyScore = Math.max(0, Math.min(1, 1 - latency / 5000));
  return quality * 0.5 + success * 0.3 + latencyScore * 0.2;
}

export async function rankedProviders(admin: SupabaseClient): Promise<Provider[]> {
  const providers = configuredProviders();
  const { data } = await admin.from("provider_health").select(
    "provider,quality_score,recent_success_rate,p95_latency_ms,circuit_open_until,enabled,free_only",
  );
  const healthByName = new Map(
    (data ?? []).map((row) => [row.provider, row as ProviderHealth & {
      enabled: boolean;
      free_only: boolean;
    }]),
  );
  const now = Date.now();
  return providers
    .filter((provider) => {
      const health = healthByName.get(provider.name);
      if (health && (!health.enabled || !health.free_only)) return false;
      return !health?.circuit_open_until ||
        new Date(health.circuit_open_until).getTime() <= now;
    })
    .sort((a, b) =>
      providerScore(b, healthByName.get(b.name)) -
      providerScore(a, healthByName.get(a.name))
    );
}

function prompt(input: TranslationInput): { system: string; user: string } {
  if (input.scope === "word") {
    return {
      system:
        "You are an English-to-Simplified-Chinese reading assistant. " +
        "Use the current sentence and the adjacent sentences. Translate only the selection. " +
        "Return one strict JSON object with lemma, phonetic, partOfSpeech, translation, commonTranslation, referent. " +
        "If the selection is a pronoun or demonstrative " +
        "(it, its, itself, they, them, their, this, that, these, those, he, him, his, she, her, one, ones, which, who, whom), " +
        "set referent=true, leave commonTranslation empty, and put the antecedent in translation as " +
        "Simplified Chinese like 指代脉冲星 or 指代前文的恒星风. Never gloss these as 它/它们/这些/那些/这个/那个. " +
        "For other tiny function words (the, a, an, of, to, and, or), also set referent=true, " +
        "describe only their role in THIS sentence, and leave commonTranslation empty. " +
        "For content words: referent=false; translation is the contextual sense in 1-12 characters; " +
        "commonTranslation is the usual dictionary sense only when it clearly differs, otherwise empty. " +
        "Use empty strings when lemma, phonetic, or partOfSpeech cannot be verified. No markdown.",
      user: JSON.stringify({
        selectedWord: input.word,
        previousSentence: normalized(input.before),
        currentSentence: normalized(input.sentence),
        nextSentence: normalized(input.after),
      }),
    };
  }
  return {
    system:
      "Translate ONLY the current English sentence into natural, accurate Simplified Chinese. " +
      "Adjacent sentences are context only: use them to resolve pronouns, references, tense, tone, and word sense. " +
      "Do not translate the adjacent sentences, do not summarize, and do not add facts that are not in the current sentence. " +
      "Prefer contextual meaning over word-for-word calque. Preserve names and factual meaning. " +
      "Return one strict JSON object with translation. No markdown.",
    user: JSON.stringify({
      previousSentence: normalized(input.before),
      currentSentence: normalized(input.sentence),
      nextSentence: normalized(input.after),
    }),
  };
}

function parseResult(raw: string, scope: "word" | "sentence"): Record<string, string | boolean> {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("INVALID_JSON");
  const parsed = JSON.parse(unfenced.slice(start, end + 1));
  const translation = String(parsed.translation ?? "").trim();
  if (
    !translation ||
    PLACEHOLDERS.has(translation) ||
    !/[\u3400-\u9fff]/u.test(translation)
  ) {
    throw new Error("INVALID_TRANSLATION");
  }
  if (scope === "sentence") return { translation };
  const referent = Boolean(parsed.referent) || /^(?:文中)?指代/.test(translation);
  if (BARE_PRONOUN_GLOSSES.has(translation)) throw new Error("BARE_PRONOUN");
  if (translation.length > 56) throw new Error("GLOSS_TOO_LONG");
  let common = String(parsed.commonTranslation ?? "").trim();
  if (referent || PLACEHOLDERS.has(common) || !/[\u3400-\u9fff]/u.test(common) || common.length > 40 || common === translation) {
    common = "";
  }
  return {
    translation,
    lemma: String(parsed.lemma ?? "").trim(),
    partOfSpeech: String(parsed.partOfSpeech ?? "").trim(),
    phonetic: String(parsed.phonetic ?? "").trim(),
    commonTranslation: common,
    referent,
  };
}

async function callProvider(
  provider: Provider,
  input: TranslationInput,
  timeoutMs: number,
): Promise<{ result: Record<string, string | boolean>; latencyMs: number }> {
  const startedAt = performance.now();
  const messages = prompt(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${provider.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
        temperature: 0.05,
        max_tokens: input.scope === "word" ? 120 : 300,
        stream: false,
        enable_thinking: false,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) {
      const error = new Error(`PROVIDER_HTTP_${response.status}`) as Error & {
        status?: number;
        retryAfter?: string | null;
      };
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after");
      throw error;
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("INVALID_PROVIDER_RESPONSE");
    return {
      result: parseResult(content, input.scope),
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timer);
  }
}

function errorKind(error: unknown): {
  code: string;
  cooldownSeconds: number;
  rateLimited: boolean;
  timeout: boolean;
} {
  const value = error as Error & { status?: number; retryAfter?: string | null };
  const timeout = value.name === "AbortError";
  const rateLimited = value.status === 429;
  const retryAfter = Math.min(300, Math.max(10, Number(value.retryAfter ?? 0) || 0));
  return {
    code: timeout ? "TIMEOUT" : rateLimited ? "RATE_LIMITED" : value.message.slice(0, 80),
    cooldownSeconds: rateLimited ? retryAfter || 45 : timeout ? 20 : 10,
    rateLimited,
    timeout,
  };
}

async function recordProvider(
  admin: SupabaseClient,
  provider: Provider,
  success: boolean,
  latencyMs: number,
  error?: unknown,
): Promise<void> {
  const { data: current } = await admin.from("provider_health")
    .select("*").eq("provider", provider.name).maybeSingle();
  const total = Number(current?.success_count ?? 0) + Number(current?.failure_count ?? 0);
  const oldRate = Number(current?.recent_success_rate ?? 1);
  const nextRate = oldRate * 0.85 + (success ? 1 : 0) * 0.15;
  const detail = error ? errorKind(error) : null;
  await admin.from("provider_health").upsert({
    provider: provider.name,
    model: provider.model,
    enabled: true,
    free_only: true,
    recent_success_rate: Math.max(0, Math.min(1, nextRate)),
    p95_latency_ms: success
      ? Math.round(Number(current?.p95_latency_ms ?? latencyMs) * 0.8 + latencyMs * 0.2)
      : Number(current?.p95_latency_ms ?? 1800),
    success_count: Number(current?.success_count ?? 0) + (success ? 1 : 0),
    failure_count: Number(current?.failure_count ?? 0) + (success ? 0 : 1),
    rate_limit_count: Number(current?.rate_limit_count ?? 0) + (detail?.rateLimited ? 1 : 0),
    timeout_count: Number(current?.timeout_count ?? 0) + (detail?.timeout ? 1 : 0),
    circuit_open_until: detail
      ? new Date(Date.now() + detail.cooldownSeconds * 1000).toISOString()
      : null,
    last_error_code: detail?.code ?? null,
    updated_at: new Date().toISOString(),
    // Keeps the first run from being interpreted as a statistically stable sample.
    quality_score: Number(current?.quality_score ?? (total ? 0.8 : 0.8)),
  }, { onConflict: "provider" });
}

export async function translateFree(
  admin: SupabaseClient,
  input: TranslationInput,
): Promise<Record<string, unknown>> {
  const canonical = await canonicalHash(input);
  const { data: cached } = await admin
    .from("translation_cache")
    .select("request_hash,result,provider,model,quality,latency_ms,hit_count")
    .eq("canonical_hash", canonical)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cached) {
    await admin.from("translation_cache").update({
      hit_count: Number(cached.hit_count ?? 0) + 1,
      last_hit_at: new Date().toISOString(),
    }).eq("request_hash", cached.request_hash);
    return {
      ...cached.result,
      scope: input.scope,
      quality: cached.quality,
      provider: cached.provider,
      model: cached.model,
      cached: true,
      cacheLayer: "shared",
      latencyMs: 0,
      providerLatencyMs: cached.latency_ms,
    };
  }

  const providers = await rankedProviders(admin);
  const providerTimeout = Number(Deno.env.get("TRANSLATION_PROVIDER_TIMEOUT_MS") ?? 2200);
  const totalTimeout = Number(Deno.env.get("TRANSLATION_TOTAL_TIMEOUT_MS") ?? 4800);
  const totalStarted = performance.now();
  for (const provider of providers) {
    const remaining = totalTimeout - (performance.now() - totalStarted);
    if (remaining < 250) break;
    const started = performance.now();
    try {
      const { result, latencyMs } = await callProvider(
        provider,
        input,
        Math.min(providerTimeout, remaining),
      );
      await recordProvider(admin, provider, true, latencyMs);
      const requestHash = await sha256(`${canonical}:${provider.name}:${provider.model}`);
      const response = {
        scope: input.scope,
        quality: "contextual",
        ...result,
        provider: provider.name,
        model: provider.model,
        cached: false,
        cacheLayer: "provider",
        latencyMs: Math.round(performance.now() - totalStarted),
        providerLatencyMs: latencyMs,
      };
      await admin.from("translation_cache").upsert({
        request_hash: requestHash,
        canonical_hash: canonical,
        scope: input.scope,
        source_text_hash: await sha256(input.sentence),
        result,
        provider: provider.name,
        model: provider.model,
        prompt_version: PROMPT_VERSION,
        quality: "contextual",
        latency_ms: latencyMs,
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
      if (Math.random() < 0.02) await admin.rpc("prune_translation_cache", { max_rows: 50_000 });
      return response;
    } catch (error) {
      await recordProvider(
        admin,
        provider,
        false,
        Math.round(performance.now() - started),
        error,
      );
    }
  }
  throw new Error("TRANSLATION_UNAVAILABLE");
}
