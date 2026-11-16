// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyAiPanel, dailyAiArticle } from "../screens/DailyAiPanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

async function render({ state = { status: "empty" }, onGenerate = vi.fn(async () => {}), onOpen = vi.fn() } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(DailyAiPanel, {
    profile: { level: "B1", topics: ["科技"] },
    state,
    onGenerate,
    onOpen,
  })));
  return { onGenerate, onOpen };
}

async function changeSelect(name, value) {
  const select = container.querySelector(`select[name="${name}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
  setter.call(select, value);
  await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));
}

function submitButton() {
  return container.querySelector('button[type="submit"]');
}

describe("daily AI confirmation panel", () => {
  it("does not generate on render and submits all four controlled preferences", async () => {
    const { onGenerate } = await render();
    expect(onGenerate).not.toHaveBeenCalled();

    await changeSelect("interest", "历史");
    await changeSelect("form", "story");
    await changeSelect("length", "long");
    await changeSelect("cefr", "C1");
    await act(async () => submitButton().click());

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate).toHaveBeenCalledWith({
      interest: "历史",
      form: "story",
      length: "long",
      cefr: "C1",
    });
  });

  it("disables duplicate confirmation while a request is pending", async () => {
    let finish;
    const onGenerate = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    await render({ onGenerate });
    await act(async () => submitButton().click());
    await act(async () => submitButton().click());
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(submitButton().disabled).toBe(true);
    await act(async () => finish());
  });

  it("opens the cached article without offering regeneration", async () => {
    const article = { id: "daily-ai-ready", title: "A Cached Article", cefr: "B2", paragraphs: ["Readable."] };
    const { onGenerate, onOpen } = await render({
      state: { status: "ready", article, request: { cefr: "B2" } },
    });
    expect(container.textContent).toContain("A Cached Article");
    expect(container.textContent).not.toContain("重新生成");
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent.includes("开始阅读"));
    await act(async () => button.click());
    expect(onOpen).toHaveBeenCalledWith(article);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("keeps the ordinary reading fallback visible after failure without retrying", async () => {
    const { onGenerate } = await render({
      state: { status: "failed", error: "MODEL_UNAVAILABLE", article: null },
    });
    expect(container.textContent).toContain("下面的今日阅读");
    expect(container.textContent).not.toContain("确认生成");
    expect(container.textContent).not.toContain("重新生成");
    expect(onGenerate).not.toHaveBeenCalled();
  });
});


describe("daily AI reading boundaries", () => {
  it("only exposes a ready article with a readable body to the shared catalog", () => {
    const article = { id: "daily-ai-body", paragraphs: ["A complete paragraph."] };
    expect(dailyAiArticle({ status: "ready", article })).toBe(article);
    expect(dailyAiArticle({ status: "ready", article: { id: "empty", paragraphs: [] } })).toBeNull();
    expect(dailyAiArticle({ status: "failed", article: null })).toBeNull();
    expect(dailyAiArticle({ status: "empty", article: null })).toBeNull();
  });

  it("does not show an active confirmation before the initial status arrives", async () => {
    const { onGenerate } = await render({ state: null });
    expect(container.textContent).toContain("正在读取");
    expect(submitButton()).toBeNull();
    expect(onGenerate).not.toHaveBeenCalled();
  });
});
