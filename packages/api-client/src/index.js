import { createClient } from "@supabase/supabase-js";
import {
  newIdempotencyKey,
  newReviewCard,
  scheduleReview,
  sentenceKey,
  serializeCard,
  usernameToInternalEmail,
  vocabularyItemId,
} from "@soda-reading/core";

export function vocabularyRecord(userId, item) {
  const translation = String(item?.translation || "");
  return {
    user_id: userId,
    content_hash: item.contentHash || item.contentId,
    content_id: item.contentId,
    word: item.word,
    lemma: item.lemma || null,
    part_of_speech: item.partOfSpeech || null,
    phonetic: item.phonetic || null,
    translation,
    common_translation: String(item.commonTranslation || "").slice(0, 40),
    referent: Boolean(item.referent) || /^(?:文中)?指代/.test(translation.trim()),
    sentence: item.sentence,
    sentence_key: sentenceKey(item.sentence),
    before_context: item.before || "",
    after_context: item.after || "",
  };
}

export function vocabularyWriteAttempts(record) {
  const withoutGloss = { ...record };
  delete withoutGloss.common_translation;
  delete withoutGloss.referent;
  const legacy = { ...withoutGloss };
  delete legacy.sentence_key;
  return [
    { record, onConflict: "user_id,content_hash,normalized_word,sentence_key" },
    { record: withoutGloss, onConflict: "user_id,content_hash,normalized_word,sentence_key" },
    { record: legacy, onConflict: "user_id,content_hash,normalized_word" },
  ];
}

export function vocabularyFromRow(item) {
  const mapped = {
    id: vocabularyItemId(item.content_id || item.content_hash, item.word, item.sentence),
    remoteId: item.id,
    word: item.word,
    lemma: item.lemma,
    partOfSpeech: item.part_of_speech,
    phonetic: item.phonetic,
    translation: item.translation,
    sentence: item.sentence,
    contentHash: item.content_hash,
    contentId: item.content_id,
    card: item.vocabulary_cards?.[0] ?? null,
  };
  if (item.common_translation) mapped.commonTranslation = item.common_translation;
  if (item.referent === true) mapped.referent = true;
  return mapped;
}

export class SodaApiError extends Error {
  constructor(message, { code = "REQUEST_FAILED", status = 0, retryable = false } = {}) {
    super(message);
    this.name = "SodaApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function mapProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name,
    role: profile.role,
    level: profile.cefr,
    topics: profile.topics,
    minutes: profile.daily_minutes,
    reminder: String(profile.reminder_time ?? "20:30").slice(0, 5),
    reviewLimit: profile.review_limit,
    mustChangePassword: profile.must_change_password,
    active: profile.is_active,
    onboarded: !profile.must_change_password,
  };
}

function functionError(error, response) {
  const context = error?.context;
  const payload = context?.json ? context.json().catch(() => ({})) : Promise.resolve({});
  return payload.then((detail) => {
    throw new SodaApiError(
      detail.message || error?.message || "请求失败",
      {
        code: detail.code || "EDGE_FUNCTION_ERROR",
        status: context?.status ?? response?.status ?? 0,
        retryable: Boolean(detail.retryable),
      },
    );
  });
}

export function createSodaClient({ url, anonKey, authStorage, fetch: customFetch } = {}) {
  if (!url || !anonKey) throw new Error("Supabase URL 与匿名密钥不能为空");
  const supabase = createClient(url, anonKey, {
    auth: {
      storage: authStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: customFetch ? { fetch: customFetch } : undefined,
  });
  const fetcher = customFetch ?? globalThis.fetch.bind(globalThis);

  async function invoke(name, options = {}) {
    const { data, error, response } = await supabase.functions.invoke(name, options);
    if (error) return await functionError(error, response);
    return data;
  }

  return {
    raw: supabase,

    async login(username, password) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: usernameToInternalEmail(username),
        password,
      });
      if (error) {
        throw new SodaApiError("用户名或密码不正确", {
          code: "INVALID_CREDENTIALS",
          status: 401,
        });
      }
      try {
        const profile = await this.getProfile();
        return { session: data.session, user: data.user, profile };
      } catch (profileError) {
        await supabase.auth.signOut({ scope: "local" });
        throw profileError;
      }
    },

    async logout() {
      await supabase.auth.signOut({ scope: "local" });
    },

    async session() {
      const { data } = await supabase.auth.getSession();
      return data.session;
    },

    onAuthStateChange(callback) {
      return supabase.auth.onAuthStateChange(callback);
    },

    async getProfile() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return null;
      const { data, error } = await supabase.from("profiles")
        .select("*").eq("id", userData.user.id).single();
      if (error) throw new SodaApiError("无法读取账号资料", { code: "PROFILE_FAILED" });
      return mapProfile(data);
    },

    async changePassword(password) {
      const result = await invoke("change-password", { body: { password } });
      await supabase.auth.signOut({ scope: "local" });
      return result;
    },

    async savePreferences(profile) {
      const session = await this.session();
      if (!session?.user?.id) throw new SodaApiError("请先登录", { code: "AUTH_REQUIRED" });
      const { data, error } = await supabase.from("profiles").update({
        cefr: profile.level,
        topics: profile.topics,
        daily_minutes: profile.minutes,
        reminder_time: profile.reminder,
        review_limit: profile.reviewLimit ?? 20,
      }).eq("id", session.user.id).select().single();
      if (error) throw new SodaApiError("设置同步失败", { code: "PROFILE_SYNC_FAILED", retryable: true });
      return mapProfile(data);
    },

    async dailyFeed() {
      return await invoke("daily-feed", { method: "GET" });
    },

    async translate(payload, signal) {
      const session = await this.session();
      if (!session?.access_token) throw new SodaApiError("请先登录", { code: "AUTH_REQUIRED", status: 401 });
      const response = await fetcher(`${url}/functions/v1/translate`, {
        method: "POST",
        signal,
        headers: {
          "apikey": anonKey,
          "Authorization": `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...payload, qualityMode: "free" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new SodaApiError(data.message || "翻译失败", {
          code: data.code || `HTTP_${response.status}`,
          status: response.status,
          retryable: Boolean(data.retryable),
        });
      }
      return data;
    },

    async saveProgress({ contentHash, contentId, chapterId, location, progress }) {
      const session = await this.session();
      if (!session?.user?.id) return { saved: false, offline: true };
      const { error } = await supabase.from("reading_progress").upsert({
        user_id: session.user.id,
        content_hash: contentHash,
        content_id: contentId,
        chapter_id: chapterId,
        location: location ?? {},
        progress,
        last_read_at: new Date().toISOString(),
      }, { onConflict: "user_id,content_hash" });
      if (error) throw new SodaApiError("阅读进度同步失败", {
        code: "PROGRESS_SYNC_FAILED",
        retryable: true,
      });
      return { saved: true };
    },

    async loadProgress() {
      const { data, error } = await supabase.from("reading_progress").select("*");
      if (error) throw new SodaApiError("读取进度失败", { code: "PROGRESS_LOAD_FAILED", retryable: true });
      return data ?? [];
    },

    async saveVocabulary(item) {
      const session = await this.session();
      if (!session?.user?.id) throw new SodaApiError("请先登录", { code: "AUTH_REQUIRED" });
      const record = vocabularyRecord(session.user.id, item);
      let data = null;
      let error = null;
      for (const attempt of vocabularyWriteAttempts(record)) {
        ({ data, error } = await supabase.from("vocabulary_items")
          .upsert(attempt.record, { onConflict: attempt.onConflict })
          .select().single());
        if (!error) break;
      }
      if (error) throw new SodaApiError("生词同步失败", { code: "VOCABULARY_SYNC_FAILED", retryable: true });
      const initial = serializeCard(newReviewCard());
      await supabase.from("vocabulary_cards").upsert({
        vocabulary_id: data.id,
        user_id: session.user.id,
        ...initial,
      }, { onConflict: "vocabulary_id", ignoreDuplicates: true });
      return data;
    },

    async deleteVocabulary(id) {
      const { error } = await supabase.from("vocabulary_items").delete().eq("id", id);
      if (error) throw new SodaApiError("删除生词失败", { code: "VOCABULARY_DELETE_FAILED", retryable: true });
    },

    async loadVocabulary() {
      const { data, error } = await supabase.from("vocabulary_items")
        .select("*,vocabulary_cards(*)").order("created_at", { ascending: false });
      if (error) throw new SodaApiError("读取生词失败", { code: "VOCABULARY_LOAD_FAILED", retryable: true });
      return (data ?? []).map((item) => vocabularyFromRow(item));
    },

    async reviewVocabulary(item, rating, now = new Date()) {
      const session = await this.session();
      if (!session?.user?.id) throw new SodaApiError("请先登录", { code: "AUTH_REQUIRED" });
      const outcome = scheduleReview(item.card, rating, now);
      const idempotencyKey = newIdempotencyKey();
      const { error: cardError } = await supabase.from("vocabulary_cards").upsert({
        vocabulary_id: item.remoteId ?? item.id,
        user_id: session.user.id,
        ...outcome.after,
      });
      if (cardError) throw new SodaApiError("复习进度同步失败", { code: "REVIEW_SYNC_FAILED", retryable: true });
      const { error: reviewError } = await supabase.from("vocabulary_reviews").insert({
        vocabulary_id: item.remoteId ?? item.id,
        user_id: session.user.id,
        rating,
        reviewed_at: now.toISOString(),
        state_before: outcome.before,
        state_after: outcome.after,
        idempotency_key: idempotencyKey,
      });
      if (reviewError) throw new SodaApiError("复习记录同步失败", { code: "REVIEW_LOG_FAILED", retryable: true });
      return { ...outcome, idempotencyKey };
    },

    async registerDevice({ installationId, deviceName, platform, appVersion, pushToken }) {
      const session = await this.session();
      if (!session?.user?.id) return;
      const { error } = await supabase.from("user_devices").upsert({
        user_id: session.user.id,
        installation_id: installationId,
        device_name: deviceName,
        platform,
        app_version: appVersion,
        push_token: pushToken ?? null,
        last_active_at: new Date().toISOString(),
        revoked_at: null,
      }, { onConflict: "user_id,installation_id" });
      if (error) throw new SodaApiError("设备登记失败", { code: "DEVICE_SYNC_FAILED", retryable: true });
    },

    admin: {
      async listUsers() {
        return await invoke("admin-users", { body: { action: "list" } });
      },
      async createUser(payload) {
        return await invoke("admin-users", { body: { action: "create", ...payload } });
      },
      async setUserStatus(userId, active) {
        return await invoke("admin-users", {
          body: { action: "set_status", userId, active },
        });
      },
      async revokeSessions(userId) {
        return await invoke("admin-users", {
          body: { action: "revoke_sessions", userId },
        });
      },
      async resetPassword(userId) {
        return await invoke("admin-reset-password", { body: { userId } });
      },
      async runContent(limit = 500) {
        return await invoke("admin-content-run", { body: { limit } });
      },
    },
  };
}
