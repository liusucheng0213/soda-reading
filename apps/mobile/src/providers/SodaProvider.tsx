import "react-native-url-polyfill/auto";
import NetInfo from "@react-native-community/netinfo";
import { createSodaClient } from "@soda-reading/api-client";
import { newIdempotencyKey, scheduleReview } from "@soda-reading/core";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  completeOutbox,
  enqueue,
  failOutbox,
  getOrCreateInstallationId,
  initializeDatabase,
  listDocuments,
  listLocalProgress,
  listVocabulary,
  loadCachedFeed,
  markVocabularyDeleted,
  outboxItems,
  saveCachedFeed,
  saveDocument,
  saveLocalProgress,
  updateVocabularyRemoteId,
  upsertVocabulary,
} from "../lib/database";
import { secureStorage } from "../lib/secure-storage";
import type {
  DailyFeed,
  ReadingArticle,
  SodaProfile,
  SyncState,
  VocabularyItem,
} from "../types";

type SodaContextValue = {
  ready: boolean;
  configured: boolean;
  session: any;
  profile: SodaProfile | null;
  feed: DailyFeed | null;
  documents: ReadingArticle[];
  vocabulary: VocabularyItem[];
  activeArticle: ReadingArticle | null;
  themeMode: "day" | "night";
  syncState: SyncState;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(password: string): Promise<void>;
  refreshFeed(): Promise<void>;
  updateProfile(next: SodaProfile): Promise<void>;
  addDocument(article: ReadingArticle): Promise<void>;
  openArticle(article: ReadingArticle): void;
  closeArticle(): void;
  saveWord(item: VocabularyItem): Promise<void>;
  removeWord(item: VocabularyItem): Promise<void>;
  reviewWord(item: VocabularyItem, rating: number): Promise<void>;
  saveProgress(article: ReadingArticle, progress: number): Promise<void>;
  translate(payload: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
  setThemeMode(mode: "day" | "night"): void;
  flushOutbox(): Promise<void>;
};

const SodaContext = React.createContext<SodaContextValue | null>(null);

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
const configured = Boolean(supabaseUrl && supabaseAnonKey);

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function configureReminder(reminder: string) {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("learning-reminders", {
    name: "阅读与生词复习",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  const permission = await Notifications.getPermissionsAsync();
  const status = permission.status === "granted"
    ? permission.status
    : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return;
  const [hour, minute] = reminder.split(":").map(Number);
  await Notifications.cancelAllScheduledNotificationsAsync();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "今天读一点真正感兴趣的英文",
      body: "今日推荐和到期生词已经准备好，十分钟也算完成。",
      data: { route: "/" },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: Number.isFinite(hour) ? hour : 20,
      minute: Number.isFinite(minute) ? minute : 30,
      channelId: "learning-reminders",
    },
  });
}

export function SodaProvider({ children }: { children: React.ReactNode }) {
  const client = useMemo(
    () => configured
      ? createSodaClient({ url: supabaseUrl, anonKey: supabaseAnonKey, authStorage: secureStorage })
      : null,
    [],
  );
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [profile, setProfile] = useState<SodaProfile | null>(null);
  const [feed, setFeed] = useState<DailyFeed | null>(null);
  const [documents, setDocuments] = useState<ReadingArticle[]>([]);
  const [vocabulary, setVocabulary] = useState<VocabularyItem[]>([]);
  const [activeArticle, setActiveArticle] = useState<ReadingArticle | null>(null);
  const [themeMode, setThemeMode] = useState<"day" | "night">("day");
  const [syncState, setSyncState] = useState<SyncState>(configured ? "offline" : "unconfigured");
  const flushing = useRef(false);

  const mergeCloudVocabulary = useCallback(async () => {
    if (!client) return;
    const remoteItems = await client.loadVocabulary() as VocabularyItem[];
    for (const item of remoteItems) await upsertVocabulary(item);
    setVocabulary(await listVocabulary());
  }, [client]);

  const mergeCloudProgress = useCallback(async () => {
    if (!client) return;
    const [remoteItems, localItems] = await Promise.all([
      client.loadProgress(),
      listLocalProgress(),
    ]);
    const localByHash = new Map(localItems.map((item) => [item.contentHash, item]));
    for (const remote of remoteItems) {
      const local = localByHash.get(remote.content_hash);
      const remoteUpdatedAt = Date.parse(remote.last_read_at ?? remote.updated_at ?? "");
      const localUpdatedAt = Date.parse(local?.updatedAt ?? "");
      if (!local || !Number.isFinite(localUpdatedAt) || remoteUpdatedAt >= localUpdatedAt) {
        await saveLocalProgress(
          remote.content_hash,
          remote.content_id ?? "",
          Number(remote.progress ?? 0),
          remote.location ?? {},
        );
      } else {
        await enqueue("progress", {
          contentHash: local.contentHash,
          contentId: local.contentId,
          chapterId: "body",
          location: local.location,
          progress: local.progress,
        }, `progress-${local.contentHash}`);
      }
    }
  }, [client]);

  const feedRequest = useRef(0);
  const refreshFeed = useCallback(async () => {
    if (!client) return;
    const generation = feedRequest.current + 1;
    feedRequest.current = generation;
    try {
      const next = await client.dailyFeed() as DailyFeed;
      if (feedRequest.current !== generation) return;
      setFeed(next);
      await saveCachedFeed(next);
    } catch (error) {
      if (feedRequest.current !== generation) return;
      const cached = await loadCachedFeed();
      if (cached) setFeed({ ...cached, fallback: true });
      else throw error;
    }
  }, [client]);

  const flushOutbox = useCallback(async () => {
    if (!client || flushing.current) return;
    const network = await NetInfo.fetch();
    if (!network.isConnected) {
      setSyncState("offline");
      return;
    }
    flushing.current = true;
    setSyncState("syncing");
    try {
      for (const row of await outboxItems()) {
        const payload = JSON.parse(row.payload_json);
        try {
          if (row.kind === "progress") {
            await client.saveProgress(payload);
          } else if (row.kind === "vocabulary") {
            const saved = await client.saveVocabulary(payload);
            await updateVocabularyRemoteId(payload.id, saved.id);
          } else if (row.kind === "vocabulary-delete") {
            if (payload.remoteId) await client.deleteVocabulary(payload.remoteId);
          } else if (row.kind === "profile") {
            await client.savePreferences(payload);
          } else if (row.kind === "review") {
            const local = (await listVocabulary()).find((item) => item.id === payload.localId);
            const remoteId = local?.remoteId;
            if (!remoteId) throw new Error("VOCABULARY_NOT_SYNCED");
            const currentSession = await client.session();
            const userId = currentSession?.user?.id;
            if (!userId) throw new Error("AUTH_REQUIRED");
            const { error: cardError } = await client.raw.from("vocabulary_cards").upsert({
              vocabulary_id: remoteId,
              user_id: userId,
              ...payload.after,
            });
            if (cardError) throw cardError;
            const { error: logError } = await client.raw.from("vocabulary_reviews").insert({
              vocabulary_id: remoteId,
              user_id: userId,
              rating: payload.rating,
              reviewed_at: payload.reviewedAt,
              state_before: payload.before,
              state_after: payload.after,
              idempotency_key: payload.idempotencyKey,
            });
            if (logError && !String(logError.message).includes("duplicate")) throw logError;
          }
          await completeOutbox(row.id);
        } catch (error) {
          await failOutbox(row.id, error instanceof Error ? error.message : "SYNC_FAILED");
          if (String(error).includes("VOCABULARY_NOT_SYNCED")) continue;
          throw error;
        }
      }
      setVocabulary(await listVocabulary());
      setSyncState("synced");
    } catch {
      setSyncState("error");
    } finally {
      flushing.current = false;
    }
  }, [client]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await initializeDatabase();
      const [localDocuments, localVocabulary, cachedFeed] = await Promise.all([
        listDocuments(),
        listVocabulary(),
        loadCachedFeed(),
      ]);
      if (!mounted) return;
      setDocuments(localDocuments);
      setVocabulary(localVocabulary);
      setFeed(cachedFeed);
      if (!client) {
        setReady(true);
        return;
      }
      const existing = await client.session();
      if (existing) {
        try {
          const nextProfile = await client.getProfile() as SodaProfile;
          if (!mounted) return;
          setSession(existing);
          setProfile(nextProfile);
          if (!nextProfile.mustChangePassword) {
            await Promise.allSettled([
              refreshFeed(),
              mergeCloudVocabulary(),
            ]);
            await mergeCloudProgress().catch(() => undefined);
            await flushOutbox();
          }
        } catch {
          await client.logout();
        }
      }
      if (mounted) setReady(true);
    })();
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected) flushOutbox();
      else setSyncState("offline");
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [client, flushOutbox, mergeCloudProgress, mergeCloudVocabulary, refreshFeed]);

  async function login(username: string, password: string) {
    if (!client) throw new Error("尚未配置 Supabase，无法登录内部云端");
    const result = await client.login(username, password);
    setSession(result.session);
    setProfile(result.profile);
    if (!result.profile.mustChangePassword) {
      await Promise.allSettled([refreshFeed(), mergeCloudVocabulary()]);
      await mergeCloudProgress().catch(() => undefined);
      await flushOutbox();
      const installationId = await getOrCreateInstallationId();
      await client.registerDevice({
        installationId,
        deviceName: "Android · 内部版",
        platform: "android",
        appVersion: Constants.expoConfig?.version ?? "0.1.0",
      });
    }
  }

  async function logout() {
    await client?.logout();
    setSession(null);
    setProfile(null);
    setActiveArticle(null);
  }

  async function changePassword(password: string) {
    if (!client) throw new Error("云端尚未配置");
    await client.changePassword(password);
    setSession(null);
    setProfile(null);
    setActiveArticle(null);
  }

  async function updateProfile(next: SodaProfile) {
    setProfile(next);
    await enqueue("profile", next, "profile-current");
    await configureReminder(next.reminder);
    await flushOutbox();
  }

  async function addDocument(article: ReadingArticle) {
    await saveDocument(article);
    setDocuments(await listDocuments());
  }

  async function saveWord(item: VocabularyItem) {
    await upsertVocabulary(item);
    setVocabulary(await listVocabulary());
    await enqueue("vocabulary", item, `vocabulary-${item.id}`);
    await flushOutbox();
  }

  async function removeWord(item: VocabularyItem) {
    await markVocabularyDeleted(item.id);
    setVocabulary(await listVocabulary());
    await enqueue("vocabulary-delete", item, `vocabulary-delete-${item.id}`);
    await flushOutbox();
  }

  async function reviewWord(item: VocabularyItem, rating: number) {
    const reviewedAt = new Date();
    const outcome = scheduleReview(item.card, rating, reviewedAt);
    const next = { ...item, card: outcome.after };
    await upsertVocabulary(next);
    setVocabulary(await listVocabulary());
    await enqueue("review", {
      localId: item.id,
      rating,
      reviewedAt: reviewedAt.toISOString(),
      before: outcome.before,
      after: outcome.after,
      idempotencyKey: newIdempotencyKey(),
    });
    await flushOutbox();
  }

  async function saveProgress(article: ReadingArticle, progress: number) {
    const contentHash = article.contentHash ?? article.id;
    const payload = {
      contentHash,
      contentId: article.id,
      chapterId: "body",
      location: { progress },
      progress,
    };
    await saveLocalProgress(contentHash, article.id, progress, payload.location);
    await enqueue("progress", payload, `progress-${contentHash}`);
    await flushOutbox();
  }

  const value: SodaContextValue = {
    ready,
    configured,
    session,
    profile,
    feed,
    documents,
    vocabulary,
    activeArticle,
    themeMode,
    syncState,
    login,
    logout,
    changePassword,
    refreshFeed,
    updateProfile,
    addDocument,
    openArticle: setActiveArticle,
    closeArticle: () => setActiveArticle(null),
    saveWord,
    removeWord,
    reviewWord,
    saveProgress,
    translate: async (payload, signal) => {
      if (!client) throw new Error("免费翻译服务尚未配置");
      return await client.translate(payload, signal);
    },
    setThemeMode,
    flushOutbox,
  };

  return <SodaContext.Provider value={value}>{children}</SodaContext.Provider>;
}

export function useSoda() {
  const value = React.useContext(SodaContext);
  if (!value) throw new Error("useSoda must be used inside SodaProvider");
  return value;
}
