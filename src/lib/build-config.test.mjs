import { describe, expect, it } from "vitest";
import configFactory from "../../vite.config.mjs";

describe("build application selection", () => {
  it("forces admin-only rendering in admin mode", () => {
    const config = configFactory({ mode: "admin" });
    expect(config.define?.["import.meta.env.VITE_ADMIN_ONLY"]).toBe('"true"');
  });

  it("forces reader rendering in the default web build", () => {
    const config = configFactory({ mode: "production" });
    expect(config.define?.["import.meta.env.VITE_ADMIN_ONLY"]).toBe('"false"');
  });
});
