import { describe, expect, it, vi } from "vitest";
import { readAccountState, resolveAccountBase, writeAccountState } from "./storage.js";

describe("account storage", () => {
  it("keeps each reader's vocabulary apart and migrates the legacy key once", () => {
    const store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
    localStorage.setItem("soda.vocabulary", JSON.stringify([{ id: "1", word: "shade" }]));
    expect(readAccountState("admin", "vocabulary", [])).toEqual([{ id: "1", word: "shade" }]);
    expect(localStorage.getItem("soda.vocabulary")).toBeNull();
    writeAccountState("guest", "vocabulary", [{ id: "2", word: "tree" }]);
    expect(readAccountState("admin", "vocabulary", [])[0].word).toBe("shade");
    expect(readAccountState("guest", "vocabulary", [])[0].word).toBe("tree");
    vi.unstubAllGlobals();
  });

  it("reads the account being switched to instead of an empty fallback", () => {
    const store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
    writeAccountState("guest", "vocabulary", [{ id: "2", word: "tree" }]);
    const switched = resolveAccountBase(
      { owner: "admin", value: [{ word: "shade" }] },
      "guest",
      "vocabulary",
      [],
    );
    expect(switched[0].word).toBe("tree");
    expect(resolveAccountBase({ owner: "guest", value: [{ word: "kept" }] }, "guest", "vocabulary", [])[0].word).toBe("kept");
    expect(resolveAccountBase({ owner: "guest", value: [{ word: "kept" }] }, "", "vocabulary", [])).toEqual([]);
    vi.unstubAllGlobals();
  });
});
