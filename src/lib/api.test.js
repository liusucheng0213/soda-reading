import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTranslationMemory, peekWordTranslation, translateWord } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearTranslationMemory();
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

  it("reuses one in-flight request and then serves memory without a second fetch", async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          scope: "word",
          quality: "contextual",
          translation: "树荫",
          lemma: "shade",
          phonetic: "/ʃeɪd/",
          partOfSpeech: "n.",
          provider: "deepseek",
          model: "deepseek-chat",
          cached: false,
          latencyMs: 420,
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = { word: "shade", sentence: "Their leaves make shade." };
    const [first, second] = await Promise.all([
      translateWord(payload),
      translateWord(payload),
    ]);
    expect(first.translation).toBe("树荫");
    expect(second.translation).toBe("树荫");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = await translateWord(payload);
    expect(cached.cacheLayer).toBe("client");
    expect(peekWordTranslation(payload).translation).toBe("树荫");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
