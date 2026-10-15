/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { clickKeepsAnnotation } from "./study.js";

describe("annotation clicks", () => {
  it("keeps the gloss open when the click lands on its reserved space", () => {
    document.body.innerHTML = `
      <ruby class="word-unit annotated">
        <span data-word-key="a">shade</span>
        <rt class="word-gloss">树荫</rt>
      </ruby>
      <p class="outside">outside</p>
    `;
    expect(clickKeepsAnnotation(document.querySelector(".annotated"))).toBe(true);
    expect(clickKeepsAnnotation(document.querySelector(".word-gloss"))).toBe(true);
    expect(clickKeepsAnnotation(document.querySelector(".outside"))).toBe(false);
  });
});
