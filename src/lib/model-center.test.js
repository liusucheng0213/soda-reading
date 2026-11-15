// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ModelTaskRoutes } from "../screens/ModelTaskRoutes.jsx";
import { ModelUsageSummary } from "../screens/ModelUsageSummary.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const routes = {
  translation: ["zhipu", "deepseek"],
  content_moderation: ["modelscope"],
  daily_article: ["custom-lab"],
};

const overview = {
  tasks: {
    translation: { attempts: 3, successes: 2, failures: 1, inputTokens: 24, outputTokens: 7, estimatedInputTokens: 12, estimatedOutputTokens: 4, estimatedCny: 0.01 },
    content_moderation: { attempts: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCny: 0 },
    daily_article: { attempts: 1, successes: 1, failures: 0, inputTokens: 40, outputTokens: 8, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCny: 0 },
  },
  cache: { memoryHits: 2, diskHits: 3, coalesced: 1, memoryEntries: 4, diskEntries: 5 },
  costGuard: { paidProvidersEnabled: false, dailyBudgetCny: 0, reservedTodayCny: 0 },
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close = function close() { this.open = false; };
});

describe("model center screens", () => {
  it("renders independent task routes and task usage", () => {
    const routeHtml = renderToStaticMarkup(React.createElement(ModelTaskRoutes, { routes, onChange: () => {} }));
    expect(routeHtml).toContain("阅读翻译");
    expect(routeHtml).toContain("内容审核");
    expect(routeHtml).toContain("每日 AI 文章");
    expect(routeHtml).toContain("zhipu,deepseek");
    expect(routeHtml).toContain("modelscope");
    expect(routeHtml).toContain("custom-lab");

    const usageHtml = renderToStaticMarkup(React.createElement(ModelUsageSummary, { overview, onRefresh: () => {} }));
    expect(usageHtml).toContain("24 / 7");
    expect(usageHtml).toContain("12 / 4");
    expect(usageHtml).toContain("2 成功");
    expect(usageHtml).toContain("1 失败");
    expect(usageHtml).toContain("磁盘 5");
    expect(usageHtml).toContain("付费已关闭");
  });

  it("clears cache only after native-dialog confirmation and refreshes usage", async () => {
    const onClearCache = vi.fn(async () => ({ cleared: 5 }));
    const onRefresh = vi.fn(async () => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(ModelUsageSummary, { overview, onRefresh, onClearCache })));

    const open = [...container.querySelectorAll("button")].find((button) => button.textContent === "清理翻译缓存");
    await act(async () => open.click());
    expect(container.querySelector("dialog").open).toBe(true);
    const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "取消");
    cancel.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await act(async () => cancel.click());
    expect(onClearCache).not.toHaveBeenCalled();

    await act(async () => open.click());
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "确认清理");
    await act(async () => confirm.click());
    expect(onClearCache).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(container.querySelector("dialog").open).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });
});
