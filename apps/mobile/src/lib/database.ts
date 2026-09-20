import * as SQLite from "expo-sqlite";
import type { DailyFeed, ReadingArticle, VocabularyItem } from "../types";

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function database() {
  if (!databasePromise) databasePromise = SQLite.openDatabaseAsync("soda-reading.db");
  return databasePromise;
}

export async function initializeDatabase() {
  const db = await database();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      article_json TEXT NOT NULL,
      file_uri TEXT NOT NULL,
      file_type TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vocabulary (
      id TEXT PRIMARY KEY NOT NULL,
      remote_id TEXT,
      item_json TEXT NOT NULL,
      card_json TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reading_progress (
      content_hash TEXT PRIMARY KEY NOT NULL,
      content_id TEXT,
      progress REAL NOT NULL DEFAULT 0,
      location_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS outbox_created_idx ON outbox(created_at);
    CREATE TABLE IF NOT EXISTS app_cache (
      cache_key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export async function saveDocument(article: ReadingArticle) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO documents(id,title,article_json,file_uri,file_type,imported_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title,
       article_json=excluded.article_json,
       file_uri=excluded.file_uri,
       file_type=excluded.file_type,
       imported_at=excluded.imported_at`,
    article.id,
    article.title,
    JSON.stringify(article),
    article.localFileUri ?? "",
    article.fileType ?? "",
    new Date().toISOString(),
  );
}

export async function listDocuments(): Promise<ReadingArticle[]> {
  const db = await database();
  const rows = await db.getAllAsync<{ article_json: string }>(
    "SELECT article_json FROM documents ORDER BY imported_at DESC",
  );
  return rows.map((row) => JSON.parse(row.article_json));
}

export async function getDocument(id: string): Promise<ReadingArticle | null> {
  const db = await database();
  const row = await db.getFirstAsync<{ article_json: string }>(
    "SELECT article_json FROM documents WHERE id = ?",
    id,
  );
  return row ? JSON.parse(row.article_json) : null;
}

export async function upsertVocabulary(item: VocabularyItem) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO vocabulary(id,remote_id,item_json,card_json,updated_at,deleted_at)
     VALUES(?,?,?,?,?,NULL)
     ON CONFLICT(id) DO UPDATE SET
       remote_id=coalesce(excluded.remote_id,vocabulary.remote_id),
       item_json=excluded.item_json,
       card_json=excluded.card_json,
       updated_at=excluded.updated_at,
       deleted_at=NULL`,
    item.id,
    item.remoteId ?? null,
    JSON.stringify(item),
    item.card ? JSON.stringify(item.card) : null,
    new Date().toISOString(),
  );
}

export async function updateVocabularyRemoteId(id: string, remoteId: string) {
  const db = await database();
  const row = await db.getFirstAsync<{ item_json: string }>(
    "SELECT item_json FROM vocabulary WHERE id = ?",
    id,
  );
  if (!row) return;
  const item = { ...JSON.parse(row.item_json), remoteId };
  await db.runAsync(
    "UPDATE vocabulary SET remote_id=?,item_json=?,updated_at=? WHERE id=?",
    remoteId,
    JSON.stringify(item),
    new Date().toISOString(),
    id,
  );
}

export async function listVocabulary(): Promise<VocabularyItem[]> {
  const db = await database();
  const rows = await db.getAllAsync<{
    item_json: string;
    card_json: string | null;
    remote_id: string | null;
  }>("SELECT item_json,card_json,remote_id FROM vocabulary WHERE deleted_at IS NULL ORDER BY updated_at DESC");
  return rows.map((row) => ({
    ...JSON.parse(row.item_json),
    remoteId: row.remote_id ?? JSON.parse(row.item_json).remoteId,
    card: row.card_json ? JSON.parse(row.card_json) : JSON.parse(row.item_json).card,
  }));
}

export async function markVocabularyDeleted(id: string) {
  const db = await database();
  await db.runAsync(
    "UPDATE vocabulary SET deleted_at=?,updated_at=? WHERE id=?",
    new Date().toISOString(),
    new Date().toISOString(),
    id,
  );
}

export async function saveLocalProgress(
  contentHash: string,
  contentId: string,
  progress: number,
  location: Record<string, unknown> = {},
) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO reading_progress(content_hash,content_id,progress,location_json,updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(content_hash) DO UPDATE SET
       content_id=excluded.content_id,
       progress=excluded.progress,
       location_json=excluded.location_json,
       updated_at=excluded.updated_at`,
    contentHash,
    contentId,
    progress,
    JSON.stringify(location),
    new Date().toISOString(),
  );
}

export async function loadLocalProgress(contentHash: string): Promise<number> {
  const db = await database();
  const row = await db.getFirstAsync<{ progress: number }>(
    "SELECT progress FROM reading_progress WHERE content_hash = ?",
    contentHash,
  );
  return row?.progress ?? 0;
}

export async function listLocalProgress(): Promise<Array<{
  contentHash: string;
  contentId: string;
  progress: number;
  location: Record<string, unknown>;
  updatedAt: string;
}>> {
  const db = await database();
  const rows = await db.getAllAsync<{
    content_hash: string;
    content_id: string;
    progress: number;
    location_json: string;
    updated_at: string;
  }>("SELECT content_hash,content_id,progress,location_json,updated_at FROM reading_progress");
  return rows.map((row) => ({
    contentHash: row.content_hash,
    contentId: row.content_id,
    progress: row.progress,
    location: JSON.parse(row.location_json || "{}"),
    updatedAt: row.updated_at,
  }));
}

export async function enqueue(kind: string, payload: Record<string, unknown>, id?: string) {
  const db = await database();
  const key = id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.runAsync(
    `INSERT INTO outbox(id,kind,payload_json,created_at)
     VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,created_at=excluded.created_at`,
    key,
    kind,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
  return key;
}

export async function outboxItems() {
  const db = await database();
  return await db.getAllAsync<{
    id: string;
    kind: string;
    payload_json: string;
    attempts: number;
  }>("SELECT id,kind,payload_json,attempts FROM outbox ORDER BY created_at LIMIT 100");
}

export async function completeOutbox(id: string) {
  const db = await database();
  await db.runAsync("DELETE FROM outbox WHERE id = ?", id);
}

export async function failOutbox(id: string, message: string) {
  const db = await database();
  await db.runAsync(
    "UPDATE outbox SET attempts=attempts+1,last_error=? WHERE id=?",
    message.slice(0, 300),
    id,
  );
}

export async function saveCachedFeed(feed: DailyFeed) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO app_cache(cache_key,value_json,updated_at) VALUES('daily-feed',?,?)
     ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
    JSON.stringify(feed),
    new Date().toISOString(),
  );
}

export async function loadCachedFeed(): Promise<DailyFeed | null> {
  const db = await database();
  const row = await db.getFirstAsync<{ value_json: string }>(
    "SELECT value_json FROM app_cache WHERE cache_key='daily-feed'",
  );
  return row ? JSON.parse(row.value_json) : null;
}

export async function getOrCreateInstallationId() {
  const db = await database();
  const row = await db.getFirstAsync<{ value_json: string }>(
    "SELECT value_json FROM app_cache WHERE cache_key='installation-id'",
  );
  if (row) return JSON.parse(row.value_json) as string;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.runAsync(
    "INSERT INTO app_cache(cache_key,value_json,updated_at) VALUES('installation-id',?,?)",
    JSON.stringify(id),
    new Date().toISOString(),
  );
  return id;
}
