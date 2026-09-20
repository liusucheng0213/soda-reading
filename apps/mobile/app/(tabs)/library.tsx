import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PageHeader, Screen, useColors } from "../../src/components/ui";
import { pickAndImport } from "../../src/lib/importer";
import { useSoda } from "../../src/providers/SodaProvider";
import type { ReadingArticle } from "../../src/types";

export default function Library() {
  const colors = useColors();
  const { documents, addDocument, openArticle } = useSoda();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function importFile() {
    setBusy(true);
    setError("");
    setStatus("正在本机检查文件…");
    try {
      const article = await pickAndImport();
      if (!article) {
        setStatus("");
        return;
      }
      await addDocument(article);
      setStatus("导入完成，原文件没有上传");
    } catch (value) {
      setStatus("");
      setError(value instanceof Error ? value.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  function open(article: ReadingArticle) {
    openArticle(article);
    router.push("/reader");
  }

  return (
    <Screen>
      <PageHeader
        eyebrow="PRIVATE LIBRARY"
        title="我的书架"
        action={<Pressable onPress={importFile} style={[styles.add, { backgroundColor: colors.accent }]}><Text style={styles.addText}>＋</Text></Pressable>}
      />
      <Pressable onPress={importFile} disabled={busy} style={[styles.import, { borderColor: colors.accent, backgroundColor: colors.accentSoft }]}>
        <Text style={[styles.importIcon, { color: colors.accentDeep }]}>⇧</Text>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[styles.importTitle, { color: colors.text }]}>{busy ? "正在安全解析…" : "导入英文书籍或文章"}</Text>
          <Text style={{ color: colors.muted, fontSize: 10 }}>EPUB · UTF-8 TXT · 文本型 PDF，最大 50 MB</Text>
        </View>
      </Pressable>
      {status ? <Text style={[styles.status, { color: colors.accentDeep }]}>{status}</Text> : null}
      {error ? <Text style={[styles.status, { color: colors.danger }]}>{error}</Text> : null}
      <View style={styles.privacy}><Text style={{ color: colors.accent }}>✓</Text><Text style={{ flex: 1, color: colors.muted, fontSize: 10, lineHeight: 16 }}>文件只保存在 App 沙盒。新设备重新导入相同文件后，可通过内容指纹恢复进度。</Text></View>
      <View style={styles.section}><Text style={[styles.sectionTitle, { color: colors.text }]}>本地内容</Text><Text style={{ color: colors.muted, fontSize: 10 }}>{documents.length} 项</Text></View>
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
        {documents.map((article) => (
          <Pressable key={article.id} onPress={() => open(article)} style={[styles.row, { borderColor: colors.line }]}>
            <View style={[styles.fileMark, { backgroundColor: colors.accentSoft }]}><Text style={{ color: colors.accentDeep, fontSize: 9, fontWeight: "700" }}>{article.fileType?.toUpperCase()}</Text></View>
            <View style={{ flex: 1, gap: 5 }}><Text numberOfLines={2} style={[styles.rowTitle, { color: colors.text }]}>{article.title}</Text><Text style={{ color: colors.muted, fontSize: 10 }}>{article.author} · {article.readingMinutes} 分钟</Text></View>
            <Text style={{ color: colors.muted }}>→</Text>
          </Pressable>
        ))}
        {!documents.length && <View style={styles.empty}><Text style={[styles.emptyTitle, { color: colors.text }]}>书架还是空的</Text><Text style={{ color: colors.muted, textAlign: "center", lineHeight: 20 }}>导入一本真正想读的英文书，从兴趣开始学习。</Text></View>}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  add: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  addText: { color: "#FFF", fontSize: 26, lineHeight: 28 },
  import: { minHeight: 98, borderWidth: 1, borderRadius: 15, padding: 17, flexDirection: "row", alignItems: "center", gap: 15 },
  importIcon: { fontSize: 29 },
  importTitle: { fontSize: 14, fontWeight: "700" },
  status: { marginTop: 10, fontSize: 11 },
  privacy: { marginTop: 14, flexDirection: "row", gap: 9 },
  section: { marginTop: 28, marginBottom: 12, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  sectionTitle: { fontFamily: "serif", fontSize: 20 },
  row: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  fileMark: { width: 46, height: 58, borderTopLeftRadius: 4, borderBottomLeftRadius: 4, borderTopRightRadius: 10, borderBottomRightRadius: 10, alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: "serif", fontSize: 15, lineHeight: 19 },
  empty: { paddingVertical: 62, alignItems: "center", gap: 9 },
  emptyTitle: { fontFamily: "serif", fontSize: 21 },
});
