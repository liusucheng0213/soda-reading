import { toByteArray } from "base64-js";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { assertSafeZip, estimateReadingMinutes } from "@soda-reading/core";
import SodaPdfBox from "soda-pdfbox";
import type { ReadingArticle } from "../types";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 100 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function cleanText(value: string) {
  return value.replace(/\0/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function htmlText(value: string) {
  return cleanText(
    value
      .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, "\""),
  );
}

function array(value: unknown): any[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function archivePath(base: string, relative: string) {
  const result: string[] = [];
  for (const part of `${base}/${relative}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return result.join("/");
}

function parseEpub(bytes: Uint8Array) {
  assertSafeZip(bytes, { maxExpandedSize: MAX_EXPANDED_SIZE });
  const files = unzipSync(bytes);
  const expanded = Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
  if (expanded > MAX_EXPANDED_SIZE) throw new Error("EPUB 解压后超过 100 MB，已停止导入");
  if (files["META-INF/encryption.xml"]) throw new Error("暂不支持 DRM 或加密 EPUB");
  const containerBytes = files["META-INF/container.xml"];
  if (!containerBytes) throw new Error("EPUB 缺少内容清单");
  const container = parser.parse(strFromU8(containerBytes));
  const rootfile = array(container?.container?.rootfiles?.rootfile)[0]?.["@_full-path"];
  if (!rootfile || !files[rootfile]) throw new Error("无法定位 EPUB 正文");
  const opf = parser.parse(strFromU8(files[rootfile]));
  const packageData = opf.package;
  const manifestItems = array(packageData?.manifest?.item);
  const manifest = new Map(manifestItems.map((item) => [item["@_id"], item["@_href"]]));
  const spine = array(packageData?.spine?.itemref);
  const base = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/")) : "";
  const chapters = spine
    .map((item) => manifest.get(item["@_idref"]))
    .filter(Boolean)
    .map((href) => files[archivePath(base, String(href))])
    .filter(Boolean)
    .map((value) => htmlText(strFromU8(value)))
    .filter((value) => value.length > 20);
  if (!chapters.length) throw new Error("EPUB 中没有可阅读正文");
  const metadata = packageData?.metadata ?? {};
  return {
    title: String(metadata["dc:title"] ?? metadata.title ?? ""),
    author: String(metadata["dc:creator"] ?? metadata.creator ?? ""),
    text: chapters.join("\n\n"),
  };
}

export async function pickAndImport(): Promise<ReadingArticle | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      "text/plain",
      "application/epub+zip",
      "application/pdf",
      "application/octet-stream",
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  if ((asset.size ?? 0) > MAX_FILE_SIZE) throw new Error("文件不能超过 50 MB");
  const extension = asset.name.split(".").pop()?.toLowerCase();
  if (!extension || !["txt", "epub", "pdf"].includes(extension)) {
    throw new Error("仅支持 EPUB、UTF-8 TXT 和文本型 PDF");
  }
  const info = await FileSystem.getInfoAsync(asset.uri);
  if (!info.exists || (info.size ?? 0) > MAX_FILE_SIZE) throw new Error("文件不存在或超过 50 MB");
  const base64 = await FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const contentHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    base64,
  );
  const importsDir = `${FileSystem.documentDirectory}imports/`;
  await FileSystem.makeDirectoryAsync(importsDir, { intermediates: true });
  const targetUri = `${importsDir}${contentHash}.${extension}`;
  await FileSystem.copyAsync({ from: asset.uri, to: targetUri });

  let text = "";
  let title = asset.name.replace(/\.[^.]+$/, "");
  let author = "本地导入";
  if (extension === "txt") {
    text = cleanText(await FileSystem.readAsStringAsync(targetUri, {
      encoding: FileSystem.EncodingType.UTF8,
    }));
  } else if (extension === "epub") {
    const parsed = parseEpub(toByteArray(base64));
    text = parsed.text;
    title = parsed.title || title;
    author = parsed.author || author;
  } else {
    text = cleanText(await SodaPdfBox.extractText(targetUri));
  }
  if (text.length < 100) {
    throw new Error(extension === "pdf"
      ? "PDF 几乎没有可提取文字，扫描件暂不支持 OCR"
      : "文件中没有足够的英文正文");
  }
  const englishLetters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (englishLetters / text.length < 0.45) throw new Error("正文不是以英文为主");
  const paragraphs = text.split(/\n{2,}/).map(cleanText).filter((value) => value.length > 0);
  return {
    id: contentHash,
    contentHash,
    title,
    author,
    source: "仅存储于此设备",
    sourceMode: "local_private",
    cefr: "未评估",
    readingMinutes: estimateReadingMinutes(text),
    paragraphs,
    localFileUri: targetUri,
    fileType: extension,
    publishedAt: new Date().toISOString(),
  };
}
