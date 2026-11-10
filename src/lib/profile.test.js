import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCAL_PROFILE, normalizeProfile } from "./profile.js";
import { migrateLocalAccount } from "./storage.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local profile", () => {
  it("starts with a usable local profile without a session", () => {
    expect(normalizeProfile(null)).toEqual({
      ...DEFAULT_LOCAL_PROFILE,
      username: "local",
      onboarded: false,
    });
    expect(normalizeProfile(null).role).toBeUndefined();
  });

  it("keeps existing preferences while removing the old account identity", () => {
    expect(normalizeProfile({ username: "admin", role: "admin", level: "B2", topics: ["自然"], minutes: 20, onboarded: true })).toMatchObject({
      username: "local",
      level: "B2",
      topics: ["自然"],
      minutes: 20,
      onboarded: true,
    });
  });

  it("moves old account buckets only after the local copy is written", () => {
    const store = new Map([
      ["soda.account.admin.vocabulary", JSON.stringify([{ id: "old", word: "shade" }])],
      ["soda.account.admin.progress", JSON.stringify({ book: 0.4 })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });

    expect(migrateLocalAccount({ username: "admin" })).toBe("local");
    expect(JSON.parse(store.get("soda.account.local.vocabulary"))[0].word).toBe("shade");
    expect(store.has("soda.account.admin.vocabulary")).toBe(false);
    expect(JSON.parse(store.get("soda.account.local.progress")).book).toBe(0.4);
  });

  it("does not overwrite existing local learning data during migration", () => {
    const store = new Map([
      ["soda.account.admin.vocabulary", JSON.stringify([{ id: "old", word: "shade" }])],
      ["soda.account.local.vocabulary", JSON.stringify([{ id: "current", word: "tree" }])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });

    migrateLocalAccount({ username: "admin" });
    expect(JSON.parse(store.get("soda.account.local.vocabulary"))[0].word).toBe("tree");
    expect(JSON.parse(store.get("soda.account.admin.vocabulary"))[0].word).toBe("shade");
  });
});
