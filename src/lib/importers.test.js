/** @vitest-environment jsdom */
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { decodeText, epubFromEntries, pdfTextFromItems } from "./importers.js";

describe("EPUB import", () => {
  it("reads namespaced package metadata and a percent-encoded chapter", () => {
    const book = epubFromEntries({
      "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>`),
      "OEBPS/content.opf": strToU8(`<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Shade Notes</dc:title>
            <dc:creator>Ada</dc:creator>
          </metadata>
          <manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
            <item id="c1" href="chap%20one.xhtml#opening" media-type="application/xhtml+xml"/>
          </manifest>
          <spine>
            <itemref idref="nav" linear="no"/>
            <itemref idref="c1"/>
          </spine>
        </package>`),
      "OEBPS/nav.xhtml": strToU8("<html><body><p>Contents should stay out of the reading text.</p></body></html>"),
      "OEBPS/chap one.xhtml": strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <nav><a href="nav.xhtml">Contents</a></nav>
        <p>Cities can feel much hotter than the fields around them.</p>
        <p>Trees make the street cooler.</p>
      </body></html>`),
    });
    expect(book.title).toBe("Shade Notes");
    expect(book.author).toBe("Ada");
    expect(book.text).toBe("Cities can feel much hotter than the fields around them.\n\nTrees make the street cooler.");
    expect(book.chapters).toEqual([
      "Cities can feel much hotter than the fields around them.\n\nTrees make the street cooler.",
    ]);
  });

  it("reads a Windows Notepad UTF-16 text file", () => {
    const bytes = new Uint8Array([
      0xFF, 0xFE,
      0x54, 0x00, 0x72, 0x00, 0x65, 0x00, 0x65, 0x00, 0x73, 0x00,
      0x20, 0x00, 0x11, 0x68,
    ]);
    expect(decodeText(bytes.buffer)).toBe("Trees 树");
    expect(decodeText(new TextEncoder().encode("Trees shade the street."))).toBe("Trees shade the street.");
  });

  it("keeps PDF lines together and starts a new paragraph after a larger gap", () => {
    const text = pdfTextFromItems([
      { str: "trans-", transform: [1, 0, 0, 1, 40, 700], width: 28 },
      { str: "piration", transform: [1, 0, 0, 1, 40, 686], width: 40 },
      { str: "cools", transform: [1, 0, 0, 1, 84, 686], width: 28 },
      { str: "the street.", transform: [1, 0, 0, 1, 40, 660], width: 52 },
    ]);
    expect(text).toBe("transpiration cools\n\nthe street.");
  });

  it("keeps table cells apart instead of gluing them into one word", () => {
    const book = epubFromEntries({
      "META-INF/container.xml": strToU8(`<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`),
      "content.opf": strToU8(`<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
      "chapter.xhtml": strToU8(`<html><body><table><tr><td>heat</td><td>island</td></tr></table><p>Trees remain.</p></body></html>`),
    });
    expect(book.text).toBe("heat island\n\nTrees remain.");
    expect(book.text).not.toContain("heatisland");
  });

  it("reads a chapter whose address starts at the book root", () => {
    const book = epubFromEntries({
      "META-INF/container.xml": strToU8(`<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`),
      "OEBPS/content.opf": strToU8(`<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c1" href="/OEBPS/root.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
      "OEBPS/root.xhtml": strToU8("<html><body><p>Trees make the street cooler.</p></body></html>"),
    });
    expect(book.text).toBe("Trees make the street cooler.");
  });

  it("does not follow a chapter path that leaves the book", () => {
    expect(() => epubFromEntries({
      "META-INF/container.xml": strToU8(`<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`),
      "content.opf": strToU8(`<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c1" href="../secret.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
      "../secret.xhtml": strToU8("<p>Cities can feel much hotter than the fields around them and this should stay unread.</p>"),
    })).toThrow("没有可阅读的正文");
  });
});