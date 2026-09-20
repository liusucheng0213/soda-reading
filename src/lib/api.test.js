import { afterEach, describe, expect, it, vi } from "vitest";
import { translateWord } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("word translation API contract", () => {
  it("returns a contextual result without replacing it with a placeholder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        scope: "word",
        quality: "contextual",
        translation: "河岸",
        commonTranslation: "银行",
        lemma: "bank",
        phonetic: "/bæŋk/",
        partOfSpeech: "n.",
        provider: "zhipu",
        model: "glm-4.7-flash",
        cached: false,
        latencyMs: 640,
      }),
    })));

    const result = await translateWord({
      word: "bank",
      sentence: "We sat on the river bank.",
    });
    expect(result.translation).toBe("河岸");
    expect(result.commonTranslation).toBe("银行");
    expect(result.quality).toBe("contextual");
  });

  it("surfaces an unavailable error for an unknown word instead of fake success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({
        detail: {
          code: "TRANSLATION_UNAVAILABLE",
          message: "当前翻译服务暂时不可用，请稍后重试",
          retryable: true,
        },
      }),
    })));

    await expect(translateWord({
      word: "unlistedword",
      sentence: "This unlistedword is only used for testing.",
    })).rejects.toMatchObject({
      code: "TRANSLATION_UNAVAILABLE",
      status: 503,
      retryable: true,
    });
  });
});
