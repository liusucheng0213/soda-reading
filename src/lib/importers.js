import { unzipSync, strFromU8 } from "fflate";
import { assertSafeZip, estimateReadingMinutes, sha256 } from "./reader.js";

export const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 100 * 1024 * 1024;

export function decodeText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes);
  let pairs = 0;
  let oddZeros = 0;
  const sample = Math.min(bytes.length, 240);
  for (let index = 1; index < sample; index += 2) {
    pairs += 1;
    if (bytes[index] === 0) oddZeros += 1;
  }
  if (pairs >= 8 && bytes[0] !== 0 && oddZeros / pairs > 0.8) return new TextDecoder("utf-16le").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

function cleanText(text) {
  return text.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function joinPdfLines(lines) {
  let text = "";
  for (const line of lines) {
    if (!text) {
      text = line;
      continue;
    }
    if (text.endsWith("-") && /^[a-z]/.test(line)) text = `${text.slice(0, -1)}${line}`;
    else text += `${text.endsWith(" ") ? "" : " "}${line}`;
  }
  return text;
}

export function pdfTextFromItems(items = []) {
  const lines = [];
  for (const item of items) {
    if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
    const y = Number(item.transform?.[5] ?? 0);
    const x = Number(item.transform?.[4] ?? 0);
    const width = Number(item.width ?? 0);
    const last = lines.at(-1);
    if (last && Math.abs(last.y - y) <= 2) last.runs.push({ x, width, str: item.str });
    else lines.push({ y, runs: [{ x, width, str: item.str }] });
  }
  const rows = lines.map((line) => {
    const runs = [...line.runs].sort((left, right) => left.x - right.x);
    let text = "";
    let cursor = null;
    for (const run of runs) {
      if (cursor != null) {
        const gap = run.x - cursor;
        const charWidth = run.width / Math.max(1, run.str.length);
        if (gap > Math.max(1.2, charWidth * 0.35) && !text.endsWith(" ") && !run.str.startsWith(" ")) text += " ";
      }
      text += run.str;
      cursor = run.x + Math.max(0, run.width);
    }
    return { y: line.y, text: text.replace(/[ \t]+/g, " ").trim() };
  }).filter((line) => line.text);
  if (!rows.length) return "";
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) gaps.push(rows[index - 1].y - rows[index].y);
  const positive = gaps.filter((gap) => gap > 0).sort((left, right) => left - right);
  const median = positive.length ? positive[Math.floor((positive.length - 1) / 2)] : 14;
  const threshold = Math.max(median * 1.55, median + 4);
  const paragraphs = [];
  let current = [rows[0].text];
  for (let index = 1; index < rows.length; index += 1) {
    const gap = rows[index - 1].y - rows[index].y;
    if (gap > threshold || gap < -2) {
      paragraphs.push(joinPdfLines(current));
      current = [];
    }
    current.push(rows[index].text);
  }
  paragraphs.push(joinPdfLines(current));
  return paragraphs.join("\n\n");
}

const TEXT_BLOCKS = new Set([
  "address", "article", "blockquote", "div", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "p", "pre", "section", "tr",
]);

function htmlToText(html) {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script,style,noscript,svg,nav").forEach((node) => node.remove());
  const blocks = [];
  const walk = (node) => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    if (node.localName === "br") return "\n";
    const text = [...node.childNodes].map(walk).join("");
    if (node.localName === "td" || node.localName === "th") {
      const cell = text.replace(/\s+/g, " ").trim();
      return cell ? `${cell}\t` : "";
    }
    if (!TEXT_BLOCKS.has(node.localName)) return text;
    const block = text.replace(/[ \t]*\n[ \t]*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
    if (block) blocks.push(block);
    return "";
  };
  const rest = walk(document.body ?? document.documentElement).replace(/\s+/g, " ").trim();
  if (rest) blocks.push(rest);
  return cleanText(blocks.join("\n\n"));
}

function resolveArchivePath(base, relative) {
  const raw = String(relative || "").replace(/\\/g, "/");
  const parts = (raw.startsWith("/") ? raw : `${base}/${raw}`).split("/");
  const result = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return result.join("/");
}

function xmlElements(root, localName) {
  return [...root.getElementsByTagNameNS("*", localName)];
}

function decodeZipPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/").split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function epubFromEntries(entries) {
  if (entries["META-INF/encryption.xml"]) throw new Error("暂不支持带 DRM 或加密内容的 EPUB");
  const container = entries["META-INF/container.xml"];
  if (!container) throw new Error("EPUB 缺少 container.xml");
  const containerDoc = new DOMParser().parseFromString(strFromU8(container), "application/xml");
  const rootfile = decodeZipPath(xmlElements(containerDoc, "rootfile")[0]?.getAttribute("full-path"));
  if (!rootfile || !entries[rootfile]) throw new Error("无法定位 EPUB 内容清单");
  const opf = new DOMParser().parseFromString(strFromU8(entries[rootfile]), "application/xml");
  const title = xmlElements(opf, "title")[0]?.textContent?.trim();
  const author = xmlElements(opf, "creator")[0]?.textContent?.trim();
  const manifest = new Map(xmlElements(opf, "item").map((item) => [item.getAttribute("id"), item.getAttribute("href")]));
  const base = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/")) : "";
  const chapters = xmlElements(opf, "itemref")
    .filter((item) => (item.getAttribute("linear") || "yes").toLowerCase() !== "no")
    .map((item) => manifest.get(item.getAttribute("idref")))
    .filter(Boolean)
    .map((href) => entries[resolveArchivePath(base, decodeZipPath(href))])
    .filter(Boolean)
    .map((value) => htmlToText(strFromU8(value)))
    .filter(Boolean);
  if (!chapters.length) throw new Error("EPUB 中没有可阅读的正文");
  return { title, author, text: chapters.join("\n\n"), chapters };
}

async function parseEpub(buffer) {
  assertSafeZip(buffer, { maxExpandedSize: MAX_EXPANDED_SIZE });
  const entries = unzipSync(new Uint8Array(buffer));
  const expandedSize = Object.values(entries).reduce((sum, value) => sum + value.byteLength, 0);
  if (expandedSize > MAX_EXPANDED_SIZE) throw new Error("EPUB 解压后体积过大，已停止导入");
  return epubFromEntries(entries);
}

async function parsePdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  try {
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      try {
        const content = await page.getTextContent();
        pages.push(cleanText(pdfTextFromItems(content.items)));
      } finally {
        page.cleanup?.();
      }
    }
    const text = pages.filter(Boolean).join("\n\n");
    if (text.length < 100) throw new Error("PDF 几乎没有可提取文字，可能是扫描件；首版暂不支持 OCR");
    return { text, chapters: pages.filter(Boolean) };
  } finally {
    await pdf.destroy?.();
  }
}

export async function inspectAndParseFile(file) {
  if (file.size > MAX_FILE_SIZE) throw new Error("文件不能超过 50 MB");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["txt", "epub", "pdf"].includes(extension)) throw new Error("仅支持 EPUB、TXT 和文本型 PDF");
  const buffer = await file.arrayBuffer();
  let parsed;
  if (extension === "txt") parsed = { text: cleanText(decodeText(buffer)) };
  else if (extension === "epub") parsed = await parseEpub(buffer);
  else parsed = await parsePdf(buffer);
  if (!parsed.text || parsed.text.length < 40) throw new Error("文件中没有足够的英文正文");
  const id = await sha256(buffer);
  const paragraphs = parsed.text.split(/\n{2,}/).map(cleanText).filter(Boolean);
  return {
    id,
    title: parsed.title || file.name.replace(/\.[^.]+$/, ""),
    author: parsed.author || "本地导入",
    source: "仅存储于此设备",
    sourceMode: "local_private",
    publishedAt: new Date().toISOString(),
    cefr: "未评估",
    readingMinutes: estimateReadingMinutes(parsed.text),
    paragraphs,
    importedAt: new Date().toISOString(),
    fileName: file.name,
    fileType: extension,
    size: file.size,
  };
}
