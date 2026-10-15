import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTranslationMemory, loginWithPassword, peekWordTranslation, translateWord } from "./api.js";

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

  it("does not store a dictionary fallback, so the next tap can reach the cloud", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({
          detail: { code: "TRANSLATION_UNAVAILABLE", message: "线路繁忙", retryable: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          scope: "word",
          quality: "contextual",
          translation: "基础结构",
          commonTranslation: "基础设施",
          provider: "zhipu",
          model: "glm-4.7-flash",
          cached: false,
          latencyMs: 800,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const payload = { word: "infrastructure", sentence: "A public library is infrastructure." };
    const fallback = await translateWord(payload);
    expect(fallback.provider).toBe("local-corpus");
    expect(peekWordTranslation(payload)).toBeNull();
    const cloud = await translateWord(payload);
    expect(cloud.provider).toBe("zhipu");
    expect(cloud.commonTranslation).toBe("基础设施");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not describe a login failure as a translation failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await expect(loginWithPassword("reader", "secret")).rejects.toMatchObject({
      message: "无法连接服务，请检查后端是否已启动",
      code: "NETWORK_ERROR",
    });
  });

  it("keeps the translation timeout wording on the translation route", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
        });
      })));
      const pending = translateWord({ word: "shade", sentence: "Trees make shade." });
      const assertion = expect(pending).rejects.toMatchObject({
        message: "翻译请求超时，请重试",
        code: "REQUEST_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(18000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
