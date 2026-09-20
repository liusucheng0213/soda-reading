import { unzipSync, strFromU8 } from "fflate";
import { assertSafeZip, estimateReadingMinutes, sha256 } from "./reader.js";

export const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 100 * 1024 * 1024;

function cleanText(text) {
  return text.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function htmlToText(html) {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script,style,noscript,svg").forEach((node) => node.remove());
  return cleanText(document.body?.textContent ?? "");
}

function resolveArchivePath(base, relative) {
  const parts = `${base}/${relative}`.split("/");
  const result = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return result.join("/");
}

async function parseEpub(buffer) {
  assertSafeZip(buffer, { maxExpandedSize: MAX_EXPANDED_SIZE });
  const entries = unzipSync(new Uint8Array(buffer));
  const expandedSize = Object.values(entries).reduce((sum, value) => sum + value.byteLength, 0);
  if (expandedSize > MAX_EXPANDED_SIZE) throw new Error("EPUB 解压后体积过大，已停止导入");
  if (entries["META-INF/encryption.xml"]) throw new Error("暂不支持带 DRM 或加密内容的 EPUB");
  const container = entries["META-INF/container.xml"];
  if (!container) throw new Error("EPUB 缺少 container.xml");
  const containerDoc = new DOMParser().parseFromString(strFromU8(container), "application/xml");
  const rootfile = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootfile || !entries[rootfile]) throw new Error("无法定位 EPUB 内容清单");
  const opf = new DOMParser().parseFromString(strFromU8(entries[rootfile]), "application/xml");
  const title = opf.querySelector("title")?.textContent?.trim();
  const author = opf.querySelector("creator")?.textContent?.trim();
  const manifest = new Map(Array.from(opf.querySelectorAll("manifest item")).map((item) => [item.getAttribute("id"), item.getAttribute("href")]));
  const base = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/")) : "";
  const chapters = Array.from(opf.querySelectorAll("spine itemref"))
    .map((item) => manifest.get(item.getAttribute("idref")))
    .filter(Boolean)
    .map((href) => entries[resolveArchivePath(base, href)])
    .filter(Boolean)
    .map((value) => htmlToText(strFromU8(value)))
    .filter(Boolean);
  if (!chapters.length) throw new Error("EPUB 中没有可阅读的正文");
  return { title, author, text: chapters.join("\n\n"), chapters };
}

async function parsePdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  const pages = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    pages.push(cleanText(content.items.map((item) => item.str).join(" ")));
  }
  const text = pages.filter(Boolean).join("\n\n");
  if (text.length < 100) throw new Error("PDF 几乎没有可提取文字，可能是扫描件；首版暂不支持 OCR");
  return { text, chapters: pages.filter(Boolean) };
}

export async function inspectAndParseFile(file) {
  if (file.size > MAX_FILE_SIZE) throw new Error("文件不能超过 50 MB");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["txt", "epub", "pdf"].includes(extension)) throw new Error("仅支持 EPUB、TXT 和文本型 PDF");
  const buffer = await file.arrayBuffer();
  let parsed;
  if (extension === "txt") parsed = { text: cleanText(new TextDecoder("utf-8", { fatal: false }).decode(buffer)) };
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
