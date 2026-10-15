import { articleForLevel } from "@soda-reading/core";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { PageHeader, useColors } from "../../src/components/ui";
import { useSoda } from "../../src/providers/SodaProvider";
import type { CEFLevel, ReadingArticle } from "../../src/types";

const LEVELS: CEFLevel[] = ["A2", "B1", "B2", "C1"];

function dateLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

function introOf(article: ReadingArticle) {
  return article.introZh || article.summary || "";
}

export default function Home() {
  const colors = useColors();
  const { profile, feed, refreshFeed, openArticle, updateProfile } = useSoda();
  const [closedId, setClosedId] = useState("");
  const [levelBusy, setLevelBusy] = useState(false);
  const articles = [feed?.primary, ...(feed?.alternatives ?? [])].filter((item): item is ReadingArticle => Boolean(item?.id));
  const level = profile?.level || "B1";
  const picked = articleForLevel(articles, undefined, level);
  const primary = picked.article;
  const alternatives = articles.filter((item) => item.id !== primary?.id);
  const standby = Boolean(feed?.fallback) || picked.injected || Boolean(primary && primary.cefr !== level);

  async function changeLevel(level: CEFLevel) {
    if (!profile || profile.level === level || levelBusy) return;
    setLevelBusy(true);
    setClosedId("");
    try {
      await updateProfile({ ...profile, level });
      await refreshFeed();
    } finally {
      setLevelBusy(false);
    }
  }

  function open(article: ReadingArticle) {
    if (!article.paragraphs?.length) {
      setClosedId(article.id);
      return;
    }
    setClosedId("");
    openArticle(article);
    router.push("/reader");
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={levelBusy} onRefresh={refreshFeed} tintColor={colors.accent} />}
    >
      <PageHeader
        eyebrow={dateLabel().toUpperCase()}
        title={standby ? "备用导读" : "今日阅读"}
      />
      <View style={styles.levels}>
        {LEVELS.map((level) => {
          const selected = profile?.level === level;
          return (
            <Pressable
              key={level}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              disabled={levelBusy}
              onPress={() => changeLevel(level)}
              style={[styles.level, { borderColor: colors.line, backgroundColor: selected ? colors.accentSoft : colors.surface }]}
            >
              <Text style={{ color: selected ? colors.accentDeep : colors.muted, fontWeight: "700" }}>{level}</Text>
            </Pressable>
          );
        })}
      </View>
      {primary ? (
        <>
          <View style={[styles.featured, { borderColor: colors.line }]}>
            <Text style={[styles.meta, { color: colors.accentDeep }]}>{primary.topic}　{primary.cefr} · {primary.readingMinutes} 分钟</Text>
            <Text style={[styles.headline, { color: colors.text }]}>{primary.title}</Text>
            {introOf(primary) ? <Text style={[styles.summary, { color: colors.muted }]}>{introOf(primary)}</Text> : null}
            <Text style={[styles.source, { color: colors.muted }]}>{primary.source}</Text>
            <Pressable onPress={() => open(primary)} style={[styles.readButton, { backgroundColor: colors.accent }]}>
              <Text style={styles.readButtonText}>开始阅读</Text><Text style={styles.readButtonText}>→</Text>
            </Pressable>
            {closedId === primary.id ? <Text style={styles.closed}>这篇还没有正文，暂时打不开。</Text> : null}
          </View>
          {alternatives.length > 0 ? (
            <>
              <View style={styles.sectionTitle}><Text style={[styles.sectionHeading, { color: colors.text }]}>也许你还喜欢</Text></View>
              <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
                {alternatives.map((article) => (
                  <View key={article.id}>
                    <Pressable onPress={() => open(article)} style={[styles.row, { borderColor: colors.line }]}>
                      <View style={[styles.topic, { backgroundColor: colors.accentSoft }]}><Text style={{ color: colors.accentDeep, fontSize: 11 }}>{article.topic}</Text></View>
                      <View style={{ flex: 1, gap: 5 }}>
                        <Text style={[styles.rowTitle, { color: colors.text }]}>{article.title}</Text>
                        {introOf(article) ? <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>{introOf(article)}</Text> : null}
                        <Text style={{ color: colors.muted, fontSize: 10 }}>{article.cefr} · {article.readingMinutes} 分钟 · {article.source}</Text>
                      </View>
                      <Text style={{ color: colors.muted }}>→</Text>
                    </Pressable>
                    {closedId === article.id ? <Text style={styles.closed}>这篇还没有正文，暂时打不开。</Text> : null}
                  </View>
                ))}
              </View>
            </>
          ) : null}
        </>
      ) : (
        <View style={[styles.empty, { borderColor: colors.line }]}><Text style={[styles.sectionHeading, { color: colors.text }]}>推荐池正在准备</Text><Text style={{ color: colors.muted, lineHeight: 21 }}>联网后下拉刷新；已有推荐会保存在本机供离线阅读。</Text></View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 22, paddingTop: 26, paddingBottom: 36 },
  levels: { flexDirection: "row", gap: 8, marginBottom: 8 },
  level: { minWidth: 52, height: 40, borderRadius: 20, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  featured: { paddingVertical: 25, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  meta: { fontSize: 11, fontWeight: "700" },
  headline: { maxWidth: 345, marginTop: 17, fontFamily: "serif", fontSize: 34, lineHeight: 37 },
  summary: { marginTop: 13, fontSize: 14, lineHeight: 24 },
  source: { marginTop: 20, fontSize: 10 },
  reason: { marginTop: 13, paddingLeft: 10, borderLeftWidth: 2, fontSize: 10, lineHeight: 16 },
  readButton: { minHeight: 50, marginTop: 22, paddingHorizontal: 17, borderRadius: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  readButtonText: { color: "#FFF", fontWeight: "700" },
  closed: { marginTop: 10, color: "#b34848", fontSize: 12, lineHeight: 18 },
  sectionTitle: { marginTop: 28, marginBottom: 12, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  sectionHeading: { fontFamily: "serif", fontSize: 20 },
  row: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  topic: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: "serif", fontSize: 15, lineHeight: 19 },
  empty: { paddingVertical: 50, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
});
