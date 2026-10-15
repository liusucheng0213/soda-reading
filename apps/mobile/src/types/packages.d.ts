declare module "@soda-reading/core" {
  export const REVIEW_RATINGS: Array<{ id: number; key: string; label: string }>;
  export function shouldFlushProgressOnAppState(state: string): boolean;
  export function splitSentences(text: string): string[];
  export function tokenizeSentence(text: string): string[];
  export function splitSentenceEnding(text: string): { body: string; ending: string };
  export function normalizeWord(text: string): string;
  export function estimateReadingMinutes(text: string): number;
  export function assertSafeZip(
    input: Uint8Array | ArrayBuffer,
    options?: {
      maxExpandedSize?: number;
      maxEntries?: number;
      maxCompressionRatio?: number;
    },
  ): { entryCount: number; expandedSize: number; compressedSize: number };
  export function dueCards<T>(items: T[], limit?: number, now?: Date): T[];
  export function scheduleReview(
    row: Record<string, unknown> | null | undefined,
    rating: number,
    now?: Date,
  ): {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    log: Record<string, unknown>;
  };
  export function newIdempotencyKey(): string;
  export function hasCommonGloss(result: { translation?: string; commonTranslation?: string; referent?: boolean } | null | undefined): boolean;
  export function glossText(result: { translation?: string; referent?: boolean } | null | undefined): string;
  export function vocabularyItemId(contentId: string, word: string, sentence?: string): string;
  export function savedVocabularySense<T extends { translation?: string; id?: string; word?: string; sentence?: string; contentId?: string; contentHash?: string }>(
    items: T[] | null | undefined,
    contentId: string,
    word: string,
    sentence?: string,
  ): T | null;
  export function isSameVocabularyItem(
    item: { id?: string; word?: string; sentence?: string; contentId?: string; contentHash?: string } | null | undefined,
    contentId: string,
    word: string,
    sentence?: string,
  ): boolean;
  export function articleForLevel<T extends { id?: string; cefr?: string; paragraphs?: string[] }>(
    live?: T[],
    library?: T[],
    level?: string,
  ): { article: T | null; injected: boolean };
}

declare module "@soda-reading/api-client" {
  export function createSodaClient(options: {
    url: string;
    anonKey: string;
    authStorage?: {
      getItem(key: string): Promise<string | null>;
      setItem(key: string, value: string): Promise<void>;
      removeItem(key: string): Promise<void>;
    };
    fetch?: typeof fetch;
  }): any;
}

declare module "soda-pdfbox" {
  const module: { extractText(uri: string): Promise<string> };
  export default module;
}
