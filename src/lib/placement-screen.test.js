import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlacementScreen } from "../screens/PlacementScreen.jsx";

describe("placement screen", () => {
  it("starts with a readable question and explicit skip controls", () => {
    const html = renderToStaticMarkup(React.createElement(PlacementScreen, {
      onComplete: () => {},
      onCancel: () => {},
    }));
    expect(html).toContain("大致水平测试");
    expect(html).toContain("1 / 18");
    expect(html).toContain("跳过本题");
    expect(html).toContain("暂不测试");
  });
});
