import { dueCards, REVIEW_RATINGS } from "@soda-reading/core";
import * as Speech from "expo-speech";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PageHeader, PrimaryButton, Screen, useColors } from "../../src/components/ui";
import { useSoda } from "../../src/providers/SodaProvider";

export default function Review() {
  const colors = useColors();
  const { profile, vocabulary, reviewWord, removeWord } = useSoda();
  const [session, setSession] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const limit = profile?.reviewLimit ?? 20;
  const queue = useMemo(() => dueCards(vocabulary, limit), [vocabulary, limit]);
  const current = queue[0];

  async function rate(value: number) {
    if (!current || busy) return;
    setBusy(true);
    await reviewWord(current, value);
    setRevealed(false);
    setBusy(false);
  }

  if (session && current) {
    return (
      <Screen>
        <PageHeader eyebrow="FSRS REVIEW" title="今日复习" action={<Pressable onPress={() => setSession(false)} hitSlop={10}><Text style={{ color: colors.accentDeep, padding: 10 }}>退出</Text></Pressable>} />
        <View style={styles.progress}><Text style={{ color: colors.muted, fontSize: 10 }}>本轮还剩 {queue.length} 张</Text><Text style={{ color: colors.muted, fontSize: 10 }}>每日上限 {limit}</Text></View>
        <View style={[styles.card, { borderColor: colors.line }]}>
          <Pressable accessibilityLabel={`朗读 ${current.word}`} onPress={() => Speech.speak(current.word, { language: "en-US", rate: 0.9 })} style={[styles.speak, { backgroundColor: colors.accentSoft }]}><Text style={{ color: colors.accentDeep, fontSize: 19 }}>◖</Text></Pressable>
          <Text style={[styles.word, { color: colors.text }]}>{current.word}</Text>
          <Text style={[styles.sentence, { color: colors.muted }]}>{current.sentence}</Text>
          {!revealed ? (
            <PrimaryButton onPress={() => setRevealed(true)}>显示语境词义</PrimaryButton>
          ) : (
            <>
              <View style={styles.answer}><Text style={{ color: colors.muted, fontSize: 12 }}>{current.phonetic}</Text><Text style={[styles.translation, { color: colors.accentDeep }]}>{current.translation}</Text></View>
              <View style={styles.ratings}>
                {REVIEW_RATINGS.map((rating) => (
                  <Pressable key={rating.id} disabled={busy} onPress={() => rate(rating.id)} style={[styles.rating, { borderColor: colors.line }]}>
                    <Text style={{ color: rating.key === "again" ? colors.danger : rating.key === "hard" ? colors.warning : colors.accentDeep }}>{rating.label}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader eyebrow="IN CONTEXT" title="生词本" action={<View style={[styles.count, { borderColor: colors.line }]}><Text style={{ color: colors.accentDeep }}>{vocabulary.length}</Text></View>} />
      <Text style={[styles.intro, { color: colors.muted }]}>保存的是词语在当时句子里的意思，不是脱离语境的词典列表。</Text>
      {vocabulary.length ? (
        <View style={[styles.entry, { borderColor: colors.line }]}>
          <View style={{ flex: 1, gap: 5 }}><Text style={[styles.entryTitle, { color: colors.text }]}>{queue.length} 张待复习</Text><Text style={{ color: colors.muted, fontSize: 10 }}>根据掌握程度安排下次出现</Text></View>
          <Pressable disabled={!queue.length} onPress={() => setSession(true)} style={[styles.start, { backgroundColor: queue.length ? colors.accent : colors.accentSoft }]}><Text style={{ color: queue.length ? "#FFF" : colors.muted, fontSize: 11, fontWeight: "700" }}>{queue.length ? "开始复习" : "今天已完成"}</Text></Pressable>
        </View>
      ) : null}
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
        {vocabulary.map((item) => (
          <View key={item.id} style={[styles.saved, { borderColor: colors.line }]}>
            <Pressable accessibilityLabel={`删除 ${item.word}`} onPress={() => removeWord(item)} hitSlop={10} style={styles.delete}><Text style={{ color: colors.muted }}>×</Text></Pressable>
            <Text style={[styles.savedWord, { color: colors.text }]}>{item.word}<Text style={{ color: colors.muted, fontFamily: undefined, fontSize: 11 }}>　{item.phonetic}</Text></Text>
            <Text style={{ color: colors.accentDeep, marginTop: 7, fontSize: 13 }}>{item.translation}</Text>
            <Text style={[styles.savedSentence, { color: colors.muted }]}>{item.sentence}</Text>
          </View>
        ))}
        {!vocabulary.length && <View style={styles.empty}><Text style={[styles.entryTitle, { color: colors.text }]}>还没有生词</Text><Text style={{ color: colors.muted, lineHeight: 20 }}>阅读时点击单词，再轻点收藏即可保存。</Text></View>}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  count: { width: 46, height: 46, borderRadius: 23, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  intro: { marginTop: -11, marginBottom: 23, fontSize: 12, lineHeight: 20 },
  entry: { minHeight: 82, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", gap: 15 },
  entryTitle: { fontFamily: "serif", fontSize: 19 },
  start: { minHeight: 44, paddingHorizontal: 15, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  saved: { position: "relative", paddingVertical: 19, paddingRight: 38, borderBottomWidth: StyleSheet.hairlineWidth },
  delete: { position: "absolute", right: 0, top: 13, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  savedWord: { fontFamily: "serif", fontSize: 24 },
  savedSentence: { marginTop: 9, fontFamily: "serif", fontSize: 13, lineHeight: 20 },
  empty: { paddingVertical: 62, alignItems: "center", gap: 9 },
  progress: { flexDirection: "row", justifyContent: "space-between" },
  card: { position: "relative", marginTop: 34, paddingVertical: 34, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: "center" },
  speak: { position: "absolute", top: 25, right: 0, width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  word: { fontFamily: "serif", fontSize: 42 },
  sentence: { marginVertical: 26, fontFamily: "serif", fontSize: 18, lineHeight: 30, textAlign: "center" },
  answer: { alignItems: "center", gap: 10, marginBottom: 27 },
  translation: { fontSize: 20 },
  ratings: { width: "100%", flexDirection: "row", gap: 7 },
  rating: { flex: 1, minHeight: 48, borderWidth: 1, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
