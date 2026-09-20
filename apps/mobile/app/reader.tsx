import {
  normalizeWord,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
} from "@soda-reading/core";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useColors } from "../src/components/ui";
import { loadLocalProgress } from "../src/lib/database";
import { useSoda } from "../src/providers/SodaProvider";
import type { GlossaryItem, VocabularyItem } from "../src/types";

type SentenceContext = {
  key: string;
  word?: string;
  sentence: string;
  before: string;
  after: string;
};

type WordState = SentenceContext & {
  status: "loading" | "success" | "error";
  result?: any;
  error?: string;
};

type SentenceState = SentenceContext & {
  status: "loading" | "success" | "error";
  translation?: string;
  error?: string;
};

function preparedWord(glossary: GlossaryItem[] | undefined, word: string, sentence: string) {
  const normalized = normalizeWord(word);
  return glossary?.find((item) =>
    normalizeWord(item.word || item.lemma || "") === normalized &&
    (!item.sentence || item.sentence === sentence)
  );
}

export default function Reader() {
  const colors = useColors();
  const {
    activeArticle: article,
    vocabulary,
    themeMode,
    setThemeMode,
    translate,
    saveWord,
    saveProgress,
    closeArticle,
  } = useSoda();
  const [fontScale, setFontScale] = useState(1);
  const [tools, setTools] = useState(false);
  const [wordState, setWordState] = useState<WordState | null>(null);
  const [sentenceState, setSentenceState] = useState<SentenceState | null>(null);
  const [resumeProgress, setResumeProgress] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const progressRef = useRef(0);
  const scrollRef = useRef<ScrollView>(null);
  const restoredRef = useRef(false);
  const wordAbort = useRef<AbortController | null>(null);
  const sentenceAbort = useRef<AbortController | null>(null);
  const paragraphs = article?.paragraphs ?? [];
  const sentencesByParagraph = useMemo(
    () => paragraphs.map((paragraph) => splitSentences(paragraph)),
    [paragraphs],
  );

  useEffect(() => () => {
    wordAbort.current?.abort();
    sentenceAbort.current?.abort();
  }, []);

  useEffect(() => {
    let live = true;
    restoredRef.current = false;
    setResumeProgress(0);
    if (!article) return () => { live = false; };
    loadLocalProgress(article.contentHash ?? article.id).then((progress) => {
      if (!live) return;
      progressRef.current = progress;
      setResumeProgress(progress);
    });
    return () => { live = false; };
  }, [article?.contentHash, article?.id]);

  useEffect(() => {
    if (
      restoredRef.current
      || resumeProgress <= 0
      || contentHeight <= viewportHeight
      || viewportHeight <= 0
    ) return;
    restoredRef.current = true;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        y: resumeProgress * (contentHeight - viewportHeight),
        animated: false,
      });
    });
  }, [contentHeight, resumeProgress, viewportHeight]);

  if (!article) {
    router.replace("/(tabs)");
    return null;
  }
  const currentArticle = article;

  function leave() {
    void saveProgress(currentArticle, progressRef.current);
    closeArticle();
    router.back();
  }

  async function requestWord(context: SentenceContext & { word: string }) {
    wordAbort.current?.abort();
    const controller = new AbortController();
    wordAbort.current = controller;
    setWordState({ ...context, status: "loading" });
    const prepared = preparedWord(currentArticle.glossary, context.word, context.sentence);
    if (prepared?.translation) {
      setWordState({
        ...context,
        status: "success",
        result: {
          scope: "word",
          quality: "contextual",
          translation: prepared.translation,
          lemma: prepared.lemma ?? "",
          partOfSpeech: prepared.partOfSpeech ?? "",
          phonetic: prepared.phonetic ?? "",
          provider: "soda-pregenerated",
          model: "article-edition",
          cached: true,
          cacheLayer: "article",
          latencyMs: 0,
        },
      });
      return;
    }
    try {
      const result = await translate({
        scope: "word",
        word: normalizeWord(context.word),
        sentence: context.sentence,
        before: context.before,
        after: context.after,
        contentHash: currentArticle.contentHash ?? currentArticle.id,
        qualityMode: "free",
      }, controller.signal);
      if (wordAbort.current === controller) {
        setWordState({ ...context, status: "success", result });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setWordState({
        ...context,
        status: "error",
        error: "免费翻译线路繁忙，未调用付费模型。轻点重试。",
      });
    }
  }

  function toggleWord(context: SentenceContext & { word: string }) {
    if (wordState?.key === context.key) {
      wordAbort.current?.abort();
      setWordState(null);
    } else {
      requestWord(context);
    }
  }

  async function requestSentence(context: SentenceContext) {
    sentenceAbort.current?.abort();
    const controller = new AbortController();
    sentenceAbort.current = controller;
    setSentenceState({ ...context, status: "loading", translation: "正在联系上下文…" });
    const prepared = currentArticle.sentenceTranslations?.[context.sentence];
    if (prepared) {
      setSentenceState({ ...context, status: "success", translation: prepared });
      return;
    }
    try {
      const result = await translate({
        scope: "sentence",
        sentence: context.sentence,
        before: context.before,
        after: context.after,
        contentHash: currentArticle.contentHash ?? currentArticle.id,
        qualityMode: "free",
      }, controller.signal);
      if (sentenceAbort.current === controller) {
        setSentenceState({ ...context, status: "success", translation: result.translation });
      }
    } catch {
      if (controller.signal.aborted) return;
      setSentenceState({
        ...context,
        status: "error",
        error: "免费线路繁忙，未调用付费模型。轻点重试。",
      });
    }
  }

  function toggleSentence(context: SentenceContext) {
    if (sentenceState?.key === context.key) {
      sentenceAbort.current?.abort();
      setSentenceState(null);
    } else {
      requestSentence(context);
    }
  }

  async function collectWord() {
    if (!wordState?.result || !wordState.word) return;
    const id = `${currentArticle.id}:${normalizeWord(wordState.word)}`;
    if (vocabulary.some((item) => item.id === id)) return;
    const item: VocabularyItem = {
      id,
      contentHash: currentArticle.contentHash ?? currentArticle.id,
      contentId: currentArticle.id,
      word: wordState.word,
      sentence: wordState.sentence,
      before: wordState.before,
      after: wordState.after,
      translation: wordState.result.translation,
      lemma: wordState.result.lemma,
      partOfSpeech: wordState.result.partOfSpeech,
      phonetic: wordState.result.phonetic,
    };
    await saveWord(item);
  }

  const collected = wordState?.word
    ? vocabulary.some((item) => item.id === `${currentArticle.id}:${normalizeWord(wordState.word!)}`)
    : false;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderColor: colors.line, backgroundColor: colors.background }]}>
        <Pressable onPress={leave} style={styles.icon} accessibilityLabel="返回"><Text style={[styles.iconText, { color: colors.text }]}>←</Text></Pressable>
        <Text style={[styles.brand, { color: colors.text }]}>苏打阅读</Text>
        <View style={styles.headerSpacer} />
        <Pressable onPress={() => setThemeMode(themeMode === "day" ? "night" : "day")} style={styles.icon} accessibilityLabel="切换日夜模式"><Text style={[styles.iconText, { color: colors.text }]}>{themeMode === "day" ? "☾" : "☀"}</Text></Pressable>
        <Pressable onPress={() => setTools(!tools)} style={styles.icon} accessibilityLabel="字号设置"><Text style={[styles.iconText, { color: colors.text }]}>Aa</Text></Pressable>
      </View>
      {tools ? (
        <View style={[styles.tools, { borderColor: colors.line, backgroundColor: colors.surface }]}>
          <Text style={{ color: colors.muted, fontSize: 10 }}>字号</Text>
          <Pressable onPress={() => setFontScale(Math.max(0.9, fontScale - 0.05))} style={styles.toolButton}><Text style={{ color: colors.text }}>A−</Text></Pressable>
          <Pressable onPress={() => setFontScale(Math.min(1.25, fontScale + 0.05))} style={styles.toolButton}><Text style={{ color: colors.text }}>A+</Text></Pressable>
          <Pressable disabled={!wordState?.result || collected} onPress={collectWord} style={styles.toolButton}><Text style={{ color: wordState?.result && !collected ? colors.accentDeep : colors.muted }}>{collected ? "已收藏" : "收藏当前词"}</Text></Pressable>
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        onContentSizeChange={(_width, height) => setContentHeight(height)}
        onLayout={({ nativeEvent }) => setViewportHeight(nativeEvent.layout.height)}
        scrollEventThrottle={150}
        onScroll={({ nativeEvent }) => {
          const maximum = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height;
          progressRef.current = maximum > 0 ? Math.max(0, Math.min(1, nativeEvent.contentOffset.y / maximum)) : 0;
        }}
        onMomentumScrollEnd={() => saveProgress(currentArticle, progressRef.current)}
      >
        <View style={styles.titleBlock}>
          <Text style={[styles.meta, { color: colors.accentDeep }]}>{currentArticle.topic ?? "本地内容"} · {currentArticle.cefr}</Text>
          <Text style={[styles.title, { color: colors.text }]}>{currentArticle.title}</Text>
        </View>
        {sentencesByParagraph.map((sentences, paragraphIndex) => (
          <View key={`${currentArticle.id}-${paragraphIndex}`} style={styles.paragraph}>
            {sentences.map((sentence, sentenceIndex) => {
              const key = `${paragraphIndex}-${sentenceIndex}`;
              const previousParagraph = sentencesByParagraph[paragraphIndex - 1] ?? [];
              const nextParagraph = sentencesByParagraph[paragraphIndex + 1] ?? [];
              const before = sentences[sentenceIndex - 1] ?? previousParagraph.at(-1) ?? "";
              const after = sentences[sentenceIndex + 1] ?? nextParagraph[0] ?? "";
              const ending = splitSentenceEnding(sentence);
              const activeSentence = sentenceState?.key === key;
              return (
                <View key={key} style={styles.sentence}>
                  <View style={styles.words}>
                    {tokenizeSentence(ending.body).map((token, tokenIndex) => {
                      const normalized = normalizeWord(token);
                      if (!normalized) {
                        return <Text key={tokenIndex} style={{ color: colors.text, fontFamily: "serif", fontSize: 20 * fontScale, lineHeight: 34 * fontScale }}>{token}</Text>;
                      }
                      const wordKey = `${key}-${tokenIndex}`;
                      const active = wordState?.key === wordKey;
                      const context = { key: wordKey, word: token, sentence, before, after };
                      return (
                        <View key={wordKey} style={styles.wordUnit}>
                          <Pressable hitSlop={8} onPress={() => toggleWord(context)}>
                            <Text style={[styles.bodyText, { color: colors.text, fontSize: 20 * fontScale, lineHeight: 34 * fontScale }, active && { color: colors.accentDeep }]}>{token}</Text>
                          </Pressable>
                          {active ? (
                            <Pressable
                              accessibilityLabel={
                                wordState?.status === "error"
                                  ? "重试翻译"
                                  : collected
                                    ? "已加入生词本"
                                    : "加入生词本"
                              }
                              disabled={wordState?.status === "loading" || collected}
                              hitSlop={8}
                              onPress={() => {
                                if (wordState?.status === "error") void requestWord(context);
                                else if (wordState?.status === "success") void collectWord();
                              }}
                              style={styles.inlineGloss}
                            >
                              <Text style={[styles.wordTranslation, { color: wordState?.status === "error" ? colors.danger : colors.accentDeep }]}>
                                {wordState?.status === "loading" ? "翻译中…" : wordState?.status === "error" ? "重试" : wordState?.result?.translation}
                              </Text>
                              {wordState?.status === "success" ? (
                                <Text style={[styles.collectMark, { color: collected ? colors.muted : colors.accentDeep }]}>
                                  {collected ? "✓" : "＋"}
                                </Text>
                              ) : null}
                            </Pressable>
                          ) : null}
                        </View>
                      );
                    })}
                    <Pressable
                      accessibilityLabel="显示或隐藏整句翻译"
                      onPress={() => toggleSentence({ key, sentence, before, after })}
                      style={[styles.ending, activeSentence && { backgroundColor: colors.accentSoft }]}
                    >
                      <Text style={[styles.bodyText, { color: activeSentence ? colors.accentDeep : colors.text, fontSize: 20 * fontScale }]}>{ending.ending}</Text>
                    </Pressable>
                  </View>
                  {activeSentence ? (
                    <Pressable onPress={() => sentenceState?.status === "error" && requestSentence({ key, sentence, before, after })} style={[styles.sentenceTranslation, { borderColor: colors.line, backgroundColor: colors.surface }]}>
                      <Text style={{ color: sentenceState?.status === "error" ? colors.danger : colors.accentDeep, fontSize: 14, lineHeight: 23 }}>
                        {sentenceState?.status === "loading" ? sentenceState.translation : sentenceState?.status === "error" ? sentenceState.error : sentenceState?.translation}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
        <View style={[styles.source, { borderColor: colors.line }]}>
          <Text style={{ color: colors.accent }}>✓</Text>
          <View style={{ flex: 1 }}><Text style={{ color: colors.text, fontWeight: "700", fontSize: 12 }}>{currentArticle.source}</Text><Text style={{ marginTop: 6, color: colors.muted, fontSize: 10, lineHeight: 16 }}>正文与 AI 翻译分开呈现。来源和版权策略可追溯。</Text></View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { height: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: "row", alignItems: "center" },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 19 },
  brand: { fontFamily: "serif", fontSize: 18 },
  headerSpacer: { flex: 1 },
  tools: { position: "absolute", zIndex: 4, top: 66, right: 12, minHeight: 49, borderWidth: 1, borderRadius: 11, padding: 6, flexDirection: "row", alignItems: "center", gap: 4 },
  toolButton: { minHeight: 38, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: 23, paddingTop: 34, paddingBottom: 115 },
  titleBlock: { marginBottom: 32 },
  meta: { fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  title: { marginTop: 11, fontFamily: "serif", fontSize: 32, lineHeight: 37 },
  paragraph: { marginBottom: 27 },
  sentence: { marginBottom: 4 },
  words: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" },
  wordUnit: { alignItems: "center" },
  bodyText: { fontFamily: "serif" },
  inlineGloss: { minHeight: 24, flexDirection: "row", alignItems: "center", gap: 1 },
  wordTranslation: { marginTop: -2, marginBottom: 2, fontSize: 10, lineHeight: 13 },
  collectMark: { fontSize: 10, lineHeight: 13 },
  ending: { minWidth: 44, minHeight: 44, marginLeft: -7, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  sentenceTranslation: { width: "100%", marginTop: 7, marginBottom: 9, paddingVertical: 9, paddingHorizontal: 11, borderLeftWidth: 2, borderRadius: 5 },
  source: { marginTop: 20, paddingTop: 20, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 10 },
});
