const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_ZIP_COMMENT = 0xffff;

function asciiName(bytes, start, length) {
  let result = "";
  for (let index = start; index < start + length; index += 1) {
    result += String.fromCharCode(bytes[index]);
  }
  return result;
}

export function assertSafeZip(
  input,
  {
    maxExpandedSize = 100 * 1024 * 1024,
    maxEntries = 5000,
    maxCompressionRatio = 200,
  } = {},
) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 22) throw new Error("EPUB ZIP 目录损坏");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 22 - MAX_ZIP_COMMENT);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("EPUB ZIP 中央目录缺失");

  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (diskNumber !== 0 || directoryDisk !== 0) throw new Error("不支持分卷 EPUB");
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("暂不支持 ZIP64 EPUB");
  }
  if (entryCount < 1 || entryCount > maxEntries) throw new Error("EPUB 文件条目数量异常");
  if (directoryOffset + directorySize > endOffset) throw new Error("EPUB ZIP 目录越界");

  let pointer = directoryOffset;
  let expandedSize = 0;
  let compressedSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > bytes.byteLength || view.getUint32(pointer, true) !== CENTRAL_SIGNATURE) {
      throw new Error("EPUB ZIP 条目损坏");
    }
    const flags = view.getUint16(pointer + 8, true);
    const compressed = view.getUint32(pointer + 20, true);
    const expanded = view.getUint32(pointer + 24, true);
    const fileNameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    if (flags & 0x1) throw new Error("暂不支持加密 EPUB");
    if (compressed === 0xffffffff || expanded === 0xffffffff) {
      throw new Error("暂不支持 ZIP64 EPUB");
    }
    const next = pointer + 46 + fileNameLength + extraLength + commentLength;
    if (next > bytes.byteLength) throw new Error("EPUB ZIP 文件名或扩展区越界");
    const rawName = asciiName(bytes, pointer + 46, fileNameLength).replaceAll("\\", "/");
    const pathParts = rawName.split("/");
    if (
      rawName.startsWith("/")
      || /^[A-Za-z]:/.test(rawName)
      || pathParts.includes("..")
      || rawName.includes("\0")
    ) {
      throw new Error("EPUB 包含危险文件路径");
    }
    expandedSize += expanded;
    compressedSize += compressed;
    if (expandedSize > maxExpandedSize) throw new Error("EPUB 解压后超过 100 MB，已停止导入");
    if (expanded > 10 * 1024 * 1024 && expanded / Math.max(1, compressed) > maxCompressionRatio) {
      throw new Error("EPUB 压缩比异常，已停止导入");
    }
    pointer = next;
  }
  if (pointer > directoryOffset + directorySize) throw new Error("EPUB ZIP 中央目录长度异常");
  if (
    expandedSize > 10 * 1024 * 1024
    && expandedSize / Math.max(1, compressedSize) > maxCompressionRatio
  ) {
    throw new Error("EPUB 总压缩比异常，已停止导入");
  }
  return { entryCount, expandedSize, compressedSize };
}
