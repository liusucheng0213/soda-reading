import { router } from "expo-router";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { PageHeader, useColors } from "../../src/components/ui";
import { useSoda } from "../../src/providers/SodaProvider";

function dateLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

export default function Home() {
  const colors = useColors();
  const { profile, feed, refreshFeed, openArticle } = useSoda();
  const primary = feed?.primary;

  function open(article: NonNullable<typeof primary>) {
    openArticle(article);
    router.push("/reader");
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refreshFeed} tintColor={colors.accent} />}
    >
      <PageHeader
        eyebrow={dateLabel().toUpperCase()}
        title="今日阅读"
        action={<View style={[styles.level, { borderColor: colors.line, backgroundColor: colors.surface }]}><Text style={{ color: colors.accentDeep, fontWeight: "700" }}>{profile?.level}</Text></View>}
      />
      {primary ? (
        <>
          <View style={[styles.featured, { borderColor: colors.line }]}>
            <Text style={[styles.meta, { color: colors.accentDeep }]}>{primary.topic}　{primary.cefr} · {primary.readingMinutes} 分钟</Text>
            <Text style={[styles.headline, { color: colors.text }]}>{primary.title}</Text>
            <Text style={[styles.summary, { color: colors.muted }]}>{primary.summary}</Text>
            <Text style={[styles.source, { color: colors.muted }]}>✓ {primary.source} · {feed?.fallback ? "备用导读" : "今日更新"}</Text>
            <Text style={[styles.reason, { color: colors.muted, borderColor: colors.accent }]}>{primary.recommendationReason ?? `适合你的 ${profile?.level} 水平与兴趣`}</Text>
            <Pressable onPress={() => open(primary)} style={[styles.readButton, { backgroundColor: colors.accent }]}>
              <Text style={styles.readButtonText}>开始阅读</Text><Text style={styles.readButtonText}>→</Text>
            </Pressable>
          </View>
          <View style={styles.sectionTitle}><Text style={[styles.sectionHeading, { color: colors.text }]}>也许你还喜欢</Text><Text style={{ color: colors.muted, fontSize: 10 }}>难度与兴趣匹配</Text></View>
          <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
            {(feed?.alternatives ?? []).map((article) => (
              <Pressable key={article.id} onPress={() => open(article)} style={[styles.row, { borderColor: colors.line }]}>
                <View style={[styles.topic, { backgroundColor: colors.accentSoft }]}><Text style={{ color: colors.accentDeep, fontSize: 11 }}>{article.topic}</Text></View>
                <View style={{ flex: 1, gap: 5 }}><Text style={[styles.rowTitle, { color: colors.text }]}>{article.title}</Text><Text style={{ color: colors.muted, fontSize: 10 }}>{article.cefr} · {article.readingMinutes} 分钟 · {article.source}</Text></View>
                <Text style={{ color: colors.muted }}>→</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <View style={[styles.empty, { borderColor: colors.line }]}><Text style={[styles.sectionHeading, { color: colors.text }]}>推荐池正在准备</Text><Text style={{ color: colors.muted, lineHeight: 21 }}>联网后下拉刷新；已有推荐会保存在本机供离线阅读。</Text></View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 22, paddingTop: 26, paddingBottom: 36 },
  level: { width: 46, height: 46, borderRadius: 23, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  featured: { paddingVertical: 25, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  meta: { fontSize: 11, fontWeight: "700" },
  headline: { maxWidth: 345, marginTop: 17, fontFamily: "serif", fontSize: 34, lineHeight: 37 },
  summary: { marginTop: 13, fontSize: 14, lineHeight: 24 },
  source: { marginTop: 20, fontSize: 10 },
  reason: { marginTop: 13, paddingLeft: 10, borderLeftWidth: 2, fontSize: 10, lineHeight: 16 },
  readButton: { minHeight: 50, marginTop: 22, paddingHorizontal: 17, borderRadius: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  readButtonText: { color: "#FFF", fontWeight: "700" },
  sectionTitle: { marginTop: 28, marginBottom: 12, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  sectionHeading: { fontFamily: "serif", fontSize: 20 },
  row: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  topic: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: "serif", fontSize: 15, lineHeight: 19 },
  empty: { paddingVertical: 50, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
});
