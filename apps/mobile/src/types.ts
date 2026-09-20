export type CEFLevel = "A2" | "B1" | "B2" | "C1";

export type SodaProfile = {
  id?: string;
  username: string;
  displayName?: string;
  role: "reader" | "admin";
  level: CEFLevel;
  topics: string[];
  minutes: number;
  reminder: string;
  reviewLimit: number;
  mustChangePassword: boolean;
  onboarded: boolean;
};

export type GlossaryItem = {
  word: string;
  lemma?: string;
  partOfSpeech?: string;
  phonetic?: string;
  translation: string;
  sentence?: string;
};

export type ReadingArticle = {
  id: string;
  contentHash?: string;
  title: string;
  author?: string;
  source: string;
  sourceMode?: string;
  sourceUrl?: string;
  publishedAt?: string;
  sourcePublishedAt?: string;
  cefr: string;
  topic?: string;
  readingMinutes: number;
  summary?: string;
  paragraphs: string[];
  sentenceTranslations?: Record<string, string>;
  glossary?: GlossaryItem[];
  localFileUri?: string;
  fileType?: string;
  recommendationReason?: string;
};

export type DailyFeed = {
  primary: ReadingArticle;
  alternatives: ReadingArticle[];
  editionDate?: string;
  generatedAt?: string;
  fallback?: boolean;
};

export type VocabularyItem = {
  id: string;
  remoteId?: string;
  contentHash: string;
  contentId?: string;
  word: string;
  lemma?: string;
  partOfSpeech?: string;
  phonetic?: string;
  translation: string;
  sentence: string;
  before?: string;
  after?: string;
  card?: Record<string, unknown> | null;
  createdAt?: string;
};

export type SyncState = "offline" | "syncing" | "synced" | "error" | "unconfigured";
