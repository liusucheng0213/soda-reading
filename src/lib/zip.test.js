import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { assertSafeZip } from "@soda-reading/core";

function centralDirectoryOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) return offset;
  }
  throw new Error("test archive has no central directory");
}

describe("EPUB ZIP preflight", () => {
  it("accepts a small normal EPUB archive", () => {
    const bytes = zipSync({
      "META-INF/container.xml": strToU8("<container />"),
      "OPS/chapter.xhtml": strToU8("<p>A safe chapter.</p>"),
    });
    expect(assertSafeZip(bytes).entryCount).toBe(2);
  });

  it("rejects declared expanded sizes before decompression", () => {
    const bytes = zipSync({ "chapter.xhtml": strToU8("<p>small</p>") });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const central = centralDirectoryOffset(bytes);
    view.setUint32(central + 24, 150 * 1024 * 1024, true);
    expect(() => assertSafeZip(bytes)).toThrow("解压后超过");
  });

  it("rejects path traversal entries", () => {
    const bytes = zipSync({ "../outside.xhtml": strToU8("<p>unsafe</p>") });
    expect(() => assertSafeZip(bytes)).toThrow("危险文件路径");
  });
});
