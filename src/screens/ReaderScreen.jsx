import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  BookmarkSimple,
  CaretLeft,
  CaretRight,
  Copy,
  Highlighter,
  MagnifyingGlass,
  Moon,
  Pause,
  Play,
  SpeakerHigh,
  Sun,
  TextAa,
  X,
} from "@phosphor-icons/react";
import {
  contextualDictionary,
  defaultReadingPrefs,
  lineHeightOptions,
  listenRateOptions,
  measureOptions,
  typefaceOptions,
} from "../data.js";
import { peekWordTranslation, translateSentence, translateWord } from "../lib/api.js";
import { isSameVocabularyItem, normalizeChapters, vocabularyItemId } from "@soda-reading/core";
import { upsertVocabularyItem } from "../lib/vocabulary.js";
import {
  annotateTokens,
  flattenSentences,
  normalizeWord,
  phraseFromItems,
  selectionSpan,
  speechChunks,
  spokenProgress,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
  wordKeyAtChar,
} from "../lib/reader.js";
import {
  collectChapterFindHits,
  clickKeepsAnnotation,
  copyText,
  glossText,
  hasCommonGloss,
  isReferentGloss,
  highlightId,
  keepShownGloss,
  canUseSpeech,
  resumeSpeechIfStuck,
  listenHotkeyBlocked,
  locateWordInChapters,
  markedRun,
  measureWidth,
  remainingMinutes,
  pendingReadingOffset,
  shouldRestoreReadingOffset,
  vocabMatch,
  wordContextAt,
} from "../lib/study.js";
import { chapterIdFromKey, chapterOverallProgress, legacyLocationKeyForDocument, normalizeReadingPosition, updateReadingPosition, withChapterKey } from "../lib/readingPosition.js";
import { ChapterNavigation } from "./reader/ChapterNavigation.jsx";
import { ReadingCompletion } from "./ReadingCompletion.jsx";

function keysInRange(unit, startKey, endKey) {
  const nodes = [...unit.querySelectorAll("[data-word-key]")];
  const start = nodes.findIndex((node) => node.dataset.wordKey === startKey);
  const end = nodes.findIndex((node) => node.dataset.wordKey === endKey);
  if (start < 0 && end < 0) return [];
  if (start < 0) return [endKey];
  if (end < 0) return [startKey];
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return nodes.slice(from, to + 1).map((node) => node.dataset.wordKey);
}

function wordContextFromUnit(unit, keys) {
  const sentence = unit.dataset.sentence || "";
  const sentenceKey = unit.dataset.sentenceKey || "";
  const { body } = splitSentenceEnding(sentence);
  const items = annotateTokens(tokenizeSentence(body), sentenceKey);
  const span = selectionSpan(items, keys);
  const wordKeys = span
    ? items.slice(span.start, span.end + 1).filter((item) => item.word).map((item) => item.key)
    : keys;
  return {
    word: phraseFromItems(items, span) || items.find((item) => item.key === keys[0])?.token || "",
    sentence,
    before: unit.dataset.before || "",
    after: unit.dataset.after || "",
    key: wordKeys[0] || keys[0],
    keys: wordKeys,
    sentenceKey,
  };
}

function WordGloss({ status, result, onRetry, saved, marked, onSave, onHighlight }) {
  if (!status || status === "picking") return null;
  return (
    <rt className={`word-gloss ${status === "error" ? "error" : status}`}>
      {status === "loading" && <span role="status">…</span>}
      {status === "success" && (
        <>
          <span className="word-contextual" role="status" aria-live="polite">{glossText(result)}</span>
          {hasCommonGloss(result) && (
            <span className="word-common">常见 {result.commonTranslation}</span>
          )}
          {result && (
            <span className="gloss-actions">
              <button type="button" onClick={onSave} disabled={saved} aria-pressed={saved}>{saved ? "已收藏" : "收藏"}</button>
              <button type="button" onClick={onHighlight} className={marked ? "selected" : ""} aria-pressed={marked}>{marked ? "已划线" : "划线"}</button>
            </span>
          )}
        </>
      )}
      {status === "error" && <button type="button" onClick={onRetry} aria-live="polite">重试</button>}
    </rt>
  );
}

function WordUnit({ surface, item, selected, highlighted, marked, saved, hit, current, status, result, onSelect, onRetry, onSave, onHighlight, actionSaved, actionMarked }) {
  const Tag = selected ? "ruby" : "span";
  const annotated = selected && status && status !== "picking";
  return (
    <Tag className={`word-unit${selected ? " selected" : ""}${annotated ? " annotated" : ""}${annotated && status === "success" ? " has-actions" : ""}${highlighted ? " highlighted" : ""}${marked ? " marked" : ""}${saved ? " saved" : ""}${hit ? " hit" : ""}${current ? " hit-current" : ""}${annotated && hasCommonGloss(result) ? " has-common" : ""}`}>
      <span
        className="word-surface"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-expanded={selected}
        data-word-key={item.key}
        data-word-surface={surface}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        {surface}
      </span>
      {selected && (
        <WordGloss
          status={status}
          result={result}
          onRetry={onRetry}
          saved={actionSaved}
          marked={actionMarked}
          onSave={onSave}
          onHighlight={onHighlight}
        />
      )}
    </Tag>
  );
}

function MarkedCluster({ items, hitSet, currentHitSet, savedSet, onSelect }) {
  return (
    <span className="word-cluster marked">
      <span className="word-cluster-words">
        {items.map((item) => (
          item.word ? (
            <span
              key={item.key}
              className={`word-surface${savedSet.has(item.word) ? " saved" : ""}${hitSet.has(item.key) ? " hit" : ""}${currentHitSet.has(item.key) ? " hit-current" : ""}`}
              role="button"
              tabIndex={0}
              data-word-key={item.key}
              data-word-surface={item.token}
              onClick={() => onSelect(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(item);
                }
              }}
            >
              {item.token}
            </span>
          ) : <span key={item.key}>{item.token}</span>
        ))}
      </span>
    </span>
  );
}

function PhraseCluster({ items, status, result, marked, onSelect, onRetry, onSave, onHighlight, saved, actionMarked }) {
  return (
    <ruby className={`word-cluster selected${status && status !== "picking" ? " annotated" : ""}${status === "success" ? " has-actions" : ""}${marked ? " marked" : ""}${status && status !== "picking" && hasCommonGloss(result) ? " has-common" : ""}`}>
      <span className="word-cluster-words">
        {items.map((item) => (
          item.word ? (
            <span
              key={item.key}
              className="word-surface"
              role="button"
              tabIndex={0}
              aria-pressed
              aria-expanded
              data-word-key={item.key}
              data-word-surface={item.token}
              onClick={onSelect}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect();
                }
              }}
            >
              {item.token}
            </span>
          ) : <span key={item.key}>{item.token}</span>
        ))}
      </span>
      <WordGloss
        status={status}
        result={result}
        onRetry={onRetry}
        saved={saved}
        marked={actionMarked}
        onSave={onSave}
        onHighlight={onHighlight}
      />
    </ruby>
  );
}

export function ReaderScreen({ article, theme, readingPrefs, onReadingPrefsChange, onThemeChange, onBack, vocabulary, onVocabularyChange, highlights, onHighlightsChange, progress, position, onProgress, focus, onFocusConsumed, feedback, onFeedback, onReview, onAdjustLevel }) {
  const chapters = useMemo(() => normalizeChapters(article), [article]);
  const savedPosition = normalizeReadingPosition({ chapters }, position, progress);
  const [activeChapterId, setActiveChapterId] = useState(savedPosition.chapterId);
  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeChapterId));
  const activeChapter = chapters[activeChapterIndex] ?? chapters[0];
  const currentChapterProgress = savedPosition.chapterId === activeChapterId
    ? savedPosition.chapterProgress
    : Number(savedPosition.chapterOffsets?.[activeChapterId]) || 0;
  const [selectedWord, setSelectedWord] = useState(null);
  const [wordMode, setWordMode] = useState("translate");
  const [selectedSentence, setSelectedSentence] = useState(null);
  const [sentenceResult, setSentenceResult] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [listenIndex, setListenIndex] = useState(-1);
  const listenWordKeyRef = useRef("");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [copied, setCopied] = useState("");
  const [internalFocus, setInternalFocus] = useState(null);
  const prefs = { ...defaultReadingPrefs, ...readingPrefs };
  const scrollRef = useRef(null);
  const chapterDialogRef = useRef(null);
  const listenContinuationRef = useRef("");
  const pendingScrollKeyRef = useRef("");
  const listenRef = useRef(false);
  const listenCursorRef = useRef(-1);
  const listenGenRef = useRef(0);
  const listenKeepAliveRef = useRef(0);
  const listenRateRef = useRef(Number(prefs.listenRate) || 1);
  const restoredProgress = useRef(false);
  const userMovedRef = useRef(false);
  const applyingScrollRef = useRef(false);
  const ignoreProgressRestoreRef = useRef(false);
  const articleIdRef = useRef(article.id);
  const restoreChapterRef = useRef(activeChapterId);
  const wordRequestRef = useRef(null);
  const wordModeRef = useRef("translate");
  wordModeRef.current = wordMode;
  const sentenceRequestRef = useRef(null);
  const ignoreClickRef = useRef(false);
  const pickRef = useRef(null);

  const paintListenWord = (key) => {
    const root = scrollRef.current;
    if (!root) return;
    root.querySelectorAll(".listen-word").forEach((node) => node.classList.remove("listen-word"));
    if (!key) return;
    const surface = root.querySelector(`[data-word-key="${CSS.escape(key)}"]`);
    if (!surface) return;
    if (surface.closest(".word-cluster")) surface.classList.add("listen-word");
    else surface.closest(".word-unit")?.classList.add("listen-word");
  };

  const moveListenWord = (key) => {
    listenWordKeyRef.current = key || "";
    paintListenWord(listenWordKeyRef.current);
  };

  useLayoutEffect(() => {
    paintListenWord(listenWordKeyRef.current);
  });

  const paragraphs = activeChapter?.paragraphs ?? [];
  const spoken = useMemo(() => flattenSentences(paragraphs).map((item) => ({
    ...item,
    key: withChapterKey(item.key, activeChapterId),
  })), [paragraphs, activeChapterId]);
  const spokenRef = useRef(spoken);
  spokenRef.current = spoken;
  const savedSet = useMemo(() => {
    const set = new Set();
    for (const item of vocabulary) {
      const word = normalizeWord(item.word);
      const lemma = normalizeWord(item.lemma || "");
      if (word) set.add(word);
      if (lemma) set.add(lemma);
    }
    return set;
  }, [vocabulary]);
  const articleHighlights = useMemo(
    () => (highlights ?? []).filter((item) => item.articleId === article.id),
    [highlights, article.id],
  );
  const markedKeys = useMemo(() => {
    const keys = new Set();
    for (const item of articleHighlights) {
      for (const key of item.keys || []) {
        keys.add(item.chapterId ? withChapterKey(key, item.chapterId) : legacyLocationKeyForDocument(article, key));
      }
    }
    return keys;
  }, [articleHighlights, article]);
  const findMatches = useMemo(() => collectChapterFindHits(chapters, findQuery), [chapters, findQuery]);
  const hitSet = useMemo(() => new Set(findMatches.flat()), [findMatches]);
  const currentMatch = findMatches[Math.min(findIndex, Math.max(0, findMatches.length - 1))] || [];
  const currentHit = currentMatch[0] || "";
  const currentHitSet = useMemo(() => new Set(currentMatch), [currentMatch]);

  const reportProgress = (value, chapterProgress = currentChapterProgress) => {
    if (value === progress && chapterProgress === currentChapterProgress) return;
    ignoreProgressRestoreRef.current = true;
    const nextPosition = updateReadingPosition(savedPosition, chapters, activeChapterId, chapterProgress);
    onProgress(value, { ...nextPosition, progress: value });
  };

  const changeChapter = (chapterId) => {
    if (!chapters.some((chapter) => chapter.id === chapterId) || chapterId === activeChapterId) {
      chapterDialogRef.current?.close();
      return;
    }
    if (listenRef.current) stopListening(true);
    wordRequestRef.current?.abort();
    sentenceRequestRef.current?.abort();
    setSelectedWord(null);
    setSelectedSentence(null);
    setSentenceResult(null);
    const previous = {
      ...savedPosition,
      chapterOffsets: { ...savedPosition.chapterOffsets, [activeChapterId]: currentChapterProgress },
    };
    const nextPosition = updateReadingPosition(previous, chapters, chapterId, previous.chapterOffsets[chapterId] ?? 0);
    ignoreProgressRestoreRef.current = false;
    userMovedRef.current = false;
    onProgress(nextPosition.progress, nextPosition);
    setActiveChapterId(chapterId);
    chapterDialogRef.current?.close();
  };

  useEffect(() => {
    const articleChanged = articleIdRef.current !== article.id;
    const chapterChanged = restoreChapterRef.current !== activeChapterId;
    const locationChanged = articleChanged || chapterChanged;
    articleIdRef.current = article.id;
    restoreChapterRef.current = activeChapterId;
    if (locationChanged) userMovedRef.current = false;
    const ownWrite = !locationChanged && ignoreProgressRestoreRef.current;
    ignoreProgressRestoreRef.current = false;
    if (!shouldRestoreReadingOffset({
      articleChanged: locationChanged,
      ownWrite,
      userMoved: userMovedRef.current,
      hasFocus: Boolean(focus?.word || focus?.sentence || internalFocus?.word || internalFocus?.sentence),
    })) {
      restoredProgress.current = true;
      return;
    }
    const element = scrollRef.current;
    if (!element) {
      restoredProgress.current = true;
      return undefined;
    }
    restoredProgress.current = false;
    let settled = false;
    let timer = 0;
    const finish = () => {
      timer = window.setTimeout(() => {
        applyingScrollRef.current = false;
        restoredProgress.current = true;
      }, 60);
    };
    const apply = () => {
      if (settled || userMovedRef.current) return;
      const node = scrollRef.current;
      if (!node) return;
      const target = pendingReadingOffset(node.scrollHeight, node.clientHeight, currentChapterProgress);
      if (target == null) return;
      settled = true;
      observer?.disconnect();
      applyingScrollRef.current = true;
      node.scrollTop = target;
      finish();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(element);
    apply();
    document.fonts?.ready?.then(() => {
      if (!settled) apply();
    }).catch(() => undefined);
    const giveUp = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      restoredProgress.current = true;
    }, 1500);
    return () => {
      settled = true;
      observer?.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(giveUp);
    };
  }, [article.id, activeChapterId, progress, currentChapterProgress, focus?.word, focus?.sentence, internalFocus]);

  useEffect(() => {
    const targetFocus = focus ?? internalFocus;
    if (!targetFocus?.word && !targetFocus?.sentence) return;
    if (targetFocus.chapterId && targetFocus.chapterId !== activeChapterId) {
      setActiveChapterId(targetFocus.chapterId);
      return;
    }
    userMovedRef.current = true;
    const located = locateWordInChapters(chapters, targetFocus, activeChapterId);
    if (located?.chapterId && located.chapterId !== activeChapterId) {
      setActiveChapterId(located.chapterId);
      return;
    }
    const context = wordContextAt(paragraphs, located);
    const frame = requestAnimationFrame(() => {
      const key = located?.wordKey;
      if (key) {
        scrollRef.current?.querySelector(`[data-word-key="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      if (context?.keys?.length) requestWord(context);
      if (focus) onFocusConsumed?.();
      setInternalFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [article.id, activeChapterId, focus, internalFocus]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const key = pendingScrollKeyRef.current;
      if (key) {
        scrollRef.current?.querySelector(`[data-word-key="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
        pendingScrollKeyRef.current = "";
      }
      if (listenContinuationRef.current === activeChapterId) {
        listenContinuationRef.current = "";
        startListening(0);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeChapterId]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        wordRequestRef.current?.abort();
        sentenceRequestRef.current?.abort();
        setSelectedWord(null);
        setSelectedSentence(null);
        setSentenceResult(null);
        setToolsOpen(false);
        setFindOpen(false);
        return;
      }
      const findNext = event.key === "F3" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g");
      if (!findOpen || !findNext) return;
      event.preventDefault();
      if (!findMatches.length) return;
      const dir = event.shiftKey ? -1 : 1;
      setFindIndex((value) => (value + dir + findMatches.length) % findMatches.length);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [findOpen, findMatches.length]);

  useEffect(() => {
    listenGenRef.current += 1;
    listenRef.current = false;
    clearListenKeepAlive();
    window.speechSynthesis?.cancel();
    setListening(false);
    setListenIndex(-1);
    moveListenWord("");
    return () => {
      wordRequestRef.current?.abort();
      sentenceRequestRef.current?.abort();
      listenGenRef.current += 1;
      listenRef.current = false;
      clearListenKeepAlive();
      window.speechSynthesis?.cancel();
    };
  }, [article.id]);

  useEffect(() => {
    const onFind = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      if (listenRef.current) stopListening();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [listening, listenIndex]);

  useEffect(() => {
    setFindIndex(0);
  }, [findQuery, article.id]);

  useEffect(() => {
    if (!findOpen || !currentHit) return;
    const chapterId = chapterIdFromKey(currentHit);
    if (chapterId && chapterId !== activeChapterId) {
      pendingScrollKeyRef.current = currentHit;
      changeChapter(chapterId);
      return;
    }
    const node = scrollRef.current?.querySelector(`[data-word-key="${CSS.escape(currentHit)}"]`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [findOpen, currentHit, activeChapterId]);

  useEffect(() => {
    listenRef.current = false;
    window.speechSynthesis?.cancel();
    setListening(false);
    setListenIndex(-1);
    moveListenWord("");
    listenCursorRef.current = -1;
  }, [article.id]);

  const listenRate = Number(prefs.listenRate) || 1;
  useEffect(() => {
    const previous = listenRateRef.current;
    listenRateRef.current = listenRate;
    if (previous !== listenRate && listenRef.current) {
      startListening(listenCursorRef.current < 0 ? 0 : listenCursorRef.current);
    }
  }, [listenRate]);

  useEffect(() => {
    if (!listening || listenIndex < 0 || !spoken.length) return;
    const chapterProgress = spokenProgress(listenIndex, spoken.length);
    const next = chapterOverallProgress(chapters, activeChapterId, chapterProgress);
    if (next > progress) reportProgress(next, chapterProgress);
  }, [listenIndex, listening, spoken.length, progress, activeChapterId]);

  const saveWordResult = (selection, result) => {
    if (!selection?.word || !result) return;
    const candidate = {
      id: vocabularyItemId(article.id, selection.word, selection.sentence),
      contentHash: article.contentHash ?? article.id,
      contentId: article.id,
      chapterId: selection.chapterId ?? activeChapterId,
      word: selection.word,
      sentence: selection.sentence,
      before: selection.before,
      after: selection.after,
      ...result,
    };
    onVocabularyChange((current) => upsertVocabularyItem(current, candidate));
  };

  const completeWordRequest = (selection, result) => {
    setSelectedWord({ ...selection, status: "success", result, error: "" });
    if (wordModeRef.current === "vocabulary") saveWordResult(selection, result);
  };

  const requestWord = async (context) => {
    wordRequestRef.current?.abort();
    const controller = new AbortController();
    wordRequestRef.current = controller;
    const keys = context.keys ?? (context.key ? [context.key] : []);
    const next = { ...context, keys };
    setSelectedWord({ ...next, status: "loading", result: null, error: "" });
    const query = context.word.trim();
    const normalized = query.includes(" ") ? query.toLowerCase() : normalizeWord(query);
    const remembered = vocabMatch(vocabulary, query, context.sentence, { exact: true });
    if (remembered?.translation) {
      completeWordRequest(next, {
        scope: "word",
        quality: remembered.quality || "contextual",
        translation: remembered.translation,
        commonTranslation: remembered.commonTranslation,
        referent: remembered.referent,
        lemma: remembered.lemma ?? "",
        partOfSpeech: remembered.partOfSpeech ?? "",
        phonetic: remembered.phonetic ?? "",
        provider: remembered.provider || "vocabulary",
        model: remembered.model || "saved",
        cached: true,
        cacheLayer: "vocabulary",
        latencyMs: 0,
        providerLatencyMs: 0,
      });
      return;
    }
    const prepared = !query.includes(" ") && article.glossary?.find((item) =>
      normalizeWord(item.word ?? item.lemma ?? "") === normalized &&
      (!item.sentence || item.sentence === context.sentence)
    );
    if (prepared?.translation) {
      completeWordRequest(next, {
        scope: "word",
        quality: "contextual",
        translation: prepared.translation,
        commonTranslation: prepared.commonTranslation,
        referent: prepared.referent,
        lemma: prepared.lemma ?? "",
        partOfSpeech: prepared.partOfSpeech ?? "",
        phonetic: prepared.phonetic ?? "",
        provider: "soda-pregenerated",
        model: "article-edition",
        cached: true,
        cacheLayer: "article",
        latencyMs: 0,
        providerLatencyMs: 0,
      });
      return;
    }
    const peeked = peekWordTranslation({
      word: normalized || query,
      sentence: context.sentence,
      contentHash: article.contentHash ?? article.id,
    });
    if (peeked?.translation) {
      completeWordRequest(next, peeked);
      return;
    }
    const preview = !query.includes(" ") ? contextualDictionary[normalized] : null;
    if (preview) {
      setSelectedWord({
        ...next,
        status: "success",
        error: "",
        result: {
          scope: "word",
          quality: "basic",
          ...preview,
          provider: "local-preview",
          model: "dictionary",
          cached: true,
          cacheLayer: "preview",
          latencyMs: 0,
          providerLatencyMs: 0,
        },
      });
    }
    try {
      const result = await translateWord({
        word: normalized || query,
        sentence: context.sentence,
        before: context.before,
        after: context.after,
        contentHash: article.contentHash ?? article.id,
        signal: controller.signal,
      });
      if (wordRequestRef.current !== controller) return;
      completeWordRequest(next, result);
    } catch (error) {
      if (error?.name === "AbortError" || wordRequestRef.current !== controller) return;
      setSelectedWord((current) => keepShownGloss(current, {
        ...next,
        status: "error",
        result: null,
        error: "暂时无法翻译，请稍后重试。",
      }));
    }
  };

  const handleWord = (context) => {
    if (ignoreClickRef.current) {
      ignoreClickRef.current = false;
      return;
    }
    const keys = context.keys ?? [context.key];
    const already = selectedWord?.keys?.length === keys.length && selectedWord.keys.every((key, index) => key === keys[index]);
    if (already) {
      if (wordMode === "vocabulary") {
        if (selectedWord.status === "success") saveWordResult(selectedWord, selectedWord.result);
        if (selectedWord.status === "error") requestWord(selectedWord);
        return;
      }
      wordRequestRef.current?.abort();
      setSelectedWord(null);
      return;
    }
    requestWord({ ...context, keys });
  };

  const finishPick = (event) => {
    const pick = pickRef.current;
    if (!pick || event.pointerId !== pick.pointerId) return;
    pickRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(pick.pointerId);
    } catch {
      /* already released */
    }
    window.getSelection()?.removeAllRanges();
    if (pick.scrolling || !pick.unit || pick.keys.length < 2) return;
    ignoreClickRef.current = true;
    window.setTimeout(() => {
      ignoreClickRef.current = false;
    }, 320);
    requestWord(wordContextFromUnit(pick.unit, pick.keys));
  };

  const requestSentence = async (context) => {
    sentenceRequestRef.current?.abort();
    const controller = new AbortController();
    sentenceRequestRef.current = controller;
    setSelectedSentence(context.key);
    setSentenceResult({ ...context, status: "loading", translation: "…", error: "" });
    try {
      const result = await translateSentence({
        sentence: context.sentence,
        article,
        before: context.before,
        after: context.after,
        contentHash: article.contentHash ?? article.id,
        signal: controller.signal,
      });
      if (sentenceRequestRef.current !== controller) return;
      setSentenceResult({ ...context, ...result, status: "success", error: "" });
    } catch (error) {
      if (error?.name === "AbortError" || sentenceRequestRef.current !== controller) return;
      setSentenceResult({
        ...context,
        status: "error",
        translation: "",
        error: "暂时无法翻译，请稍后重试。",
      });
    }
  };

  const handleSentence = (context) => {
    const { key } = context;
    if (selectedSentence === key) {
      sentenceRequestRef.current?.abort();
      setSelectedSentence(null);
      setSentenceResult(null);
      return;
    }
    requestSentence(context);
  };

  const saveSelectedWord = () => {
    if (!selectedWord?.result) return;
    saveWordResult(selectedWord, selectedWord.result);
  };

  const sameSelectedHighlight = (item) => {
    const keys = (item.keys ?? []).map((key) => item.chapterId ? withChapterKey(key, item.chapterId) : legacyLocationKeyForDocument(article, key));
    return keys.length === (selectedWord?.keys?.length ?? 0)
      && keys.every((key, index) => key === selectedWord.keys[index]);
  };
  const selectedIsMarked = articleHighlights.some(sameSelectedHighlight);
  const selectedIsSaved = Boolean(
    selectedWord?.word
    && vocabulary.some((entry) => isSameVocabularyItem(entry, article.id, selectedWord.word, selectedWord.sentence)),
  );
  const articleWords = vocabulary.filter((item) => (item.contentId ?? item.contentHash) === article.id || (item.contentId ?? item.contentHash) === (article.contentHash ?? article.id));
  const needle = findQuery.trim();
  const listenRatio = spokenProgress(listenIndex, spoken.length);
  const currentOverallProgress = chapterOverallProgress(chapters, activeChapterId, currentChapterProgress);
  const effectiveProgress = listenIndex >= 0
    ? chapterOverallProgress(chapters, activeChapterId, listenRatio)
    : Math.max(progress, currentOverallProgress);
  const leftMinutes = remainingMinutes(article, effectiveProgress);
  const listenKey = spoken[listenIndex]?.key || "";

  const toggleHighlight = () => {
    if (!selectedWord?.keys?.length) return;
    const id = highlightId(article.id, selectedWord.keys);
    if (selectedIsMarked) {
      onHighlightsChange((highlights ?? []).filter((item) => !sameSelectedHighlight(item)));
      return;
    }
    onHighlightsChange([...(highlights ?? []), {
      id,
      articleId: article.id,
      chapterId: activeChapterId,
      word: selectedWord.word,
      keys: selectedWord.keys,
      sentence: selectedWord.sentence,
    }]);
  };

  const copySentence = async (text) => {
    const value = text || selectedWord?.sentence || "";
    if (!value) return;
    const ok = await copyText(value);
    setCopied(ok ? "已复制" : "未复制");
    window.setTimeout(() => setCopied(""), 1400);
  };

  const jumpToKey = (key, chapterId = chapterIdFromKey(key)) => {
    if (!key) return;
    if (chapterId && chapterId !== activeChapterId) {
      pendingScrollKeyRef.current = key;
      changeChapter(chapterId);
      return;
    }
    const node = scrollRef.current?.querySelector(`[data-word-key="${CSS.escape(key)}"]`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const clearListenKeepAlive = () => {
    window.clearInterval(listenKeepAliveRef.current);
    listenKeepAliveRef.current = 0;
  };

  const stopListening = (reset = false) => {
    listenGenRef.current += 1;
    listenRef.current = false;
    clearListenKeepAlive();
    window.speechSynthesis?.cancel();
    setListening(false);
    moveListenWord("");
    if (reset) {
      setListenIndex(-1);
      listenCursorRef.current = -1;
    }
  };

  const visibleSentenceIndex = () => {
    const items = spokenRef.current;
    const root = scrollRef.current;
    if (!root || !items.length) return 0;
    const mid = root.getBoundingClientRect().top + 96;
    let best = 0;
    root.querySelectorAll("[data-sentence-key]").forEach((node) => {
      if (node.getBoundingClientRect().top > mid) return;
      const index = items.findIndex((item) => item.key === node.dataset.sentenceKey);
      if (index >= 0) best = index;
    });
    return best;
  };

  const startListening = (fromIndex = 0, options = {}) => {
    if (!("speechSynthesis" in window)) return;
    const items = spokenRef.current;
    if (!items.length) return;
    const once = Boolean(options.once);
    const start = Math.max(0, Math.min(fromIndex, items.length - 1));
    const gen = listenGenRef.current + 1;
    listenGenRef.current = gen;
    window.speechSynthesis.cancel();
    listenRef.current = true;
    clearListenKeepAlive();
    listenKeepAliveRef.current = window.setInterval(() => {
      if (!listenRef.current) {
        clearListenKeepAlive();
        return;
      }
      resumeSpeechIfStuck(window.speechSynthesis);
    }, 10000);
    setListening(true);
    setListenIndex(start);
    moveListenWord("");
    listenCursorRef.current = start;

    const speakAt = (index, chunkIndex = 0) => {
      if (listenGenRef.current !== gen || !listenRef.current) return;
      const item = items[index];
      if (!item) {
        const nextChapter = chapters[activeChapterIndex + 1];
        if (nextChapter) {
          const completedOverall = chapterOverallProgress(chapters, activeChapterId, 1);
          const completedPosition = updateReadingPosition(savedPosition, chapters, activeChapterId, 1);
          onProgress(completedOverall, completedPosition);
          const nextPosition = updateReadingPosition(completedPosition, chapters, nextChapter.id, 0);
          onProgress(completedOverall, nextPosition);
          listenContinuationRef.current = nextChapter.id;
          setActiveChapterId(nextChapter.id);
          return;
        }
        listenRef.current = false;
        clearListenKeepAlive();
        setListening(false);
        moveListenWord("");
        setListenIndex(-1);
        listenCursorRef.current = -1;
        reportProgress(1, 1);
        return;
      }
      const chunks = speechChunks(item.text);
      const chunk = chunks[chunkIndex] ?? { text: item.text, start: 0 };
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      utterance.lang = "en-US";
      utterance.rate = Number(listenRateRef.current) || 1;
      utterance.onstart = () => {
        if (listenGenRef.current !== gen || !listenRef.current) return;
        listenCursorRef.current = index;
        setListenIndex(index);
        if (chunkIndex > 0) return;
        moveListenWord("");
        const root = scrollRef.current;
        const node = root?.querySelector(`[data-sentence-key="${CSS.escape(item.key)}"]`);
        if (!root || !node) return;
        const frame = root.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        if (box.top < frame.top + 56 || box.bottom > frame.bottom - 48) {
          node.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      };
      utterance.onboundary = (event) => {
        if (listenGenRef.current !== gen || !listenRef.current || event.name !== "word") return;
        const key = wordKeyAtChar(item.key, item.text, chunk.start + event.charIndex);
        if (key && key !== listenWordKeyRef.current) moveListenWord(key);
      };
      utterance.onend = () => {
        if (listenGenRef.current !== gen || !listenRef.current) return;
        if (chunkIndex + 1 < chunks.length) {
          speakAt(index, chunkIndex + 1);
          return;
        }
        if (once) {
          listenRef.current = false;
          clearListenKeepAlive();
          setListening(false);
          moveListenWord("");
          return;
        }
        speakAt(index + 1);
      };
      utterance.onerror = (event) => {
        if (listenGenRef.current !== gen) return;
        if (event.error === "interrupted" || event.error === "canceled") return;
        if (listenRef.current) stopListening();
      };
      window.speechSynthesis.speak(utterance);
    };

    speakAt(start);
  };

  const skipListen = (delta) => {
    const current = listenCursorRef.current < 0 ? visibleSentenceIndex() : listenCursorRef.current;
    startListening(Math.max(0, Math.min(spokenRef.current.length - 1, current + delta)));
  };

  const listenFromSentence = (sentenceKey) => {
    const index = spokenRef.current.findIndex((item) => item.key === sentenceKey);
    startListening(index >= 0 ? index : visibleSentenceIndex());
  };

  const replayListen = () => {
    const current = listenCursorRef.current < 0 ? visibleSentenceIndex() : listenCursorRef.current;
    startListening(current, { once: true });
  };

  const highlightSpokenSentence = () => {
    const index = listenCursorRef.current >= 0 ? listenCursorRef.current : listenIndex;
    const item = spokenRef.current[index];
    if (!item) return;
    const { body } = splitSentenceEnding(item.text);
    const items = annotateTokens(tokenizeSentence(body), item.key);
    const tokens = items.filter((token) => token.word);
    if (!tokens.length) return;
    const keys = tokens.map((token) => token.key);
    const id = highlightId(article.id, keys);
    if ((highlights ?? []).some((entry) => entry.id === id)) return;
    onHighlightsChange([...(highlights ?? []), {
      id,
      articleId: article.id,
      chapterId: activeChapterId,
      word: phraseFromItems(items, { start: 0, end: items.length - 1 }) || tokens[0].word,
      keys,
      sentence: item.text,
    }]);
  };

  const toggleListening = () => {
    if (!("speechSynthesis" in window)) return;
    if (listening) {
      stopListening();
      return;
    }
    const pausedAt = listenCursorRef.current;
    if (pausedAt >= 0) {
      startListening(pausedAt);
      return;
    }
    const selected = spoken.findIndex((item) => item.key === selectedWord?.sentenceKey);
    startListening(selected >= 0 ? selected : visibleSentenceIndex());
  };

  const canListen = canUseSpeech();
  const listenDock = listening || listenIndex >= 0;

  useEffect(() => {
    if ((findOpen || toolsOpen) && listenRef.current) stopListening();
  }, [findOpen, toolsOpen]);

  useEffect(() => {
    const onKey = (event) => {
      if (listenHotkeyBlocked(event.target)) return;
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        toggleListening();
        return;
      }
      if ((event.key === "a" || event.key === "A") && listenDock) {
        event.preventDefault();
        replayListen();
        return;
      }
      if (event.shiftKey && (event.key === "M" || event.key === "m") && listenDock) {
        event.preventDefault();
        highlightSpokenSentence();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === "[") {
        event.preventDefault();
        skipListen(-1);
      }
      if (event.key === "]") {
        event.preventDefault();
        skipListen(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening, listenIndex, selectedWord?.sentenceKey, highlights]);

  return (
    <div
      className={`reader-screen theme-${theme} typeface-${prefs.typeface}`}
      style={{
        "--reader-scale": prefs.fontScale,
        "--reader-leading": prefs.lineHeight,
        "--reader-measure": measureWidth(prefs.measure),
      }}
    >
      <aside className="reader-desktop-nav">
        <button className="reader-back-link" onClick={onBack}><ArrowLeft size={19} />返回</button>
        <div className="reader-desktop-brand">苏打阅读<small>SODA READING</small></div>
        <div className="reader-book-info">
          <span>{article.topic ?? "本地内容"} · {article.cefr ?? "自定义"}</span>
          <h1>{article.title}</h1>
          <p>{article.author ?? article.source}</p>
        </div>
        {chapters.length > 1 && (
          <ChapterNavigation
            chapters={chapters}
            currentId={activeChapterId}
            chapterOffsets={{ ...savedPosition.chapterOffsets, [activeChapterId]: currentChapterProgress }}
            onSelect={changeChapter}
          />
        )}
        <div className="reader-chapter">
          <span>还剩</span>
          <strong>{leftMinutes} 分钟</strong>
        </div>
        <div className="reader-side-progress">
          <span><strong>{Math.round(effectiveProgress * 100)}%</strong></span>
          <div><i style={{ width: `${effectiveProgress * 100}%` }} /></div>
        </div>
      </aside>
      <section className="reader-main">
        <header className={`reader-header${canListen ? "" : " no-speech"}`}>
          <button className="reader-icon mobile-reader-back" onClick={onBack} aria-label="返回"><ArrowLeft size={24} /></button>
          <span className="reader-piece-title">{article.title}{chapters.length > 1 && <button type="button" className="chapter-menu-button" onClick={() => chapterDialogRef.current?.showModal()}>目录</button>}</span>
          <div className="reader-progress" aria-label={`还剩 ${leftMinutes} 分钟`}><span>{leftMinutes} 分钟</span><div><i style={{ width: `${effectiveProgress * 100}%` }} /></div></div>
          <button
            className={`reader-icon${listenDock ? " listening" : ""}${canListen ? "" : " speech-unavailable"}`}
            onClick={toggleListening}
            disabled={!canListen}
            aria-label={canListen ? (listening ? "暂停朗读" : listenIndex >= 0 ? "继续朗读" : "朗读全文") : "这台设备不能朗读"}
            title={canListen ? undefined : "这台设备不能朗读"}
          >
            {canListen ? (listening ? <Pause size={22} /> : listenIndex >= 0 ? <Play size={22} /> : <SpeakerHigh size={22} />) : <span className="speech-unavailable-label">不能朗读</span>}
          </button>
          <button
            className={`reader-icon${findOpen ? " listening" : ""}`}
            onClick={() => {
              if (!findOpen && listenRef.current) stopListening();
              setFindOpen((value) => !value);
            }}
            aria-label="查找"
          ><MagnifyingGlass size={22} /></button>
          <button
            type="button"
            className="reader-icon reader-vocabulary-mode"
            onClick={() => setWordMode((value) => value === "vocabulary" ? "translate" : "vocabulary")}
            aria-label="生词标记"
            aria-pressed={wordMode === "vocabulary"}
            title={wordMode === "vocabulary" ? "关闭生词标记，恢复普通点词" : "开启后，点击单词或短语即保存到生词库"}
          ><BookmarkSimple size={17} /><span>生词</span></button>
          <button className="reader-icon" onClick={() => onThemeChange(theme === "night" ? "day" : theme === "sepia" ? "night" : "sepia")} aria-label="切换纸色">{theme === "night" ? <Moon size={22} /> : <Sun size={22} />}</button>
          <button
            className="reader-icon"
            onClick={() => {
              if (!toolsOpen && listenRef.current) stopListening();
              setToolsOpen((value) => !value);
            }}
            aria-label="阅读设置"
          ><TextAa size={23} /></button>
        </header>
        <dialog ref={chapterDialogRef} className="chapter-dialog" aria-labelledby="chapter-dialog-title">
          <div className="chapter-dialog-head"><h2 id="chapter-dialog-title">章节目录</h2><form method="dialog"><button type="submit" aria-label="关闭目录"><X size={20} /></button></form></div>
          <ChapterNavigation
            chapters={chapters}
            currentId={activeChapterId}
            chapterOffsets={{ ...savedPosition.chapterOffsets, [activeChapterId]: currentChapterProgress }}
            onSelect={changeChapter}
          />
        </dialog>
        {findOpen && (
          <div className="reader-find">
            <MagnifyingGlass size={16} />
            <input
              className="find-input"
              value={findQuery}
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (!findMatches.length) return;
                const dir = event.shiftKey ? -1 : 1;
                setFindIndex((value) => (value + dir + findMatches.length) % findMatches.length);
              }}
              placeholder="查找"
              aria-label="在文章中查找"
              autoFocus
            />
            <span>{needle ? (findMatches.length ? `${Math.min(findIndex, findMatches.length - 1) + 1}/${findMatches.length}` : "无结果") : ""}</span>
            <button type="button" disabled={!findMatches.length} onClick={() => setFindIndex((value) => (value - 1 + findMatches.length) % findMatches.length)} aria-label="上一处"><CaretLeft size={16} /></button>
            <button type="button" disabled={!findMatches.length} onClick={() => setFindIndex((value) => (value + 1) % findMatches.length)} aria-label="下一处"><CaretRight size={16} /></button>
            <button type="button" onClick={() => { setFindOpen(false); setFindQuery(""); }} aria-label="关闭查找"><X size={16} /></button>
          </div>
        )}
        {listenDock && (
          <div className={`reader-listen${findOpen ? " with-find" : ""}${listening ? "" : " paused"}`}>
            <button type="button" onClick={toggleListening} aria-label={listening ? "暂停朗读" : "继续朗读"}>
              {listening ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button type="button" onClick={() => skipListen(-1)} aria-label="上一句"><CaretLeft size={16} /></button>
            <button type="button" onClick={replayListen} aria-label="再读本句"><ArrowClockwise size={16} /></button>
            <button type="button" onClick={highlightSpokenSentence} aria-label="划出本句"><Highlighter size={16} /></button>
            <div className="listen-rates" role="group" aria-label="朗读速度">
              {listenRateOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={listenRate === item.id ? "selected" : ""}
                  onClick={() => onReadingPrefsChange({ ...prefs, listenRate: item.id })}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => skipListen(1)} aria-label="下一句"><CaretRight size={16} /></button>
            <button type="button" onClick={() => stopListening(true)} aria-label="结束朗读"><X size={16} /></button>
          </div>
        )}
        {toolsOpen && (
          <div className={`reader-tools${findOpen ? " with-find" : ""}${listenDock ? " with-listen" : ""}`}>
            <div className="tool-row" role="group" aria-label="字体">
              {typefaceOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={prefs.typeface === item.id ? "selected" : ""}
                  onClick={() => onReadingPrefsChange({ ...prefs, typeface: item.id })}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="tool-row">
              <span>字号</span>
              <button type="button" onClick={() => onReadingPrefsChange({ ...prefs, fontScale: Math.max(0.9, Number((prefs.fontScale - 0.06).toFixed(2))) })}>A−</button>
              <button type="button" onClick={() => onReadingPrefsChange({ ...prefs, fontScale: Math.min(1.28, Number((prefs.fontScale + 0.06).toFixed(2))) })}>A+</button>
              <span>行距</span>
              {lineHeightOptions.map((item) => (
                <button key={item.id} type="button" className={prefs.lineHeight === item.id ? "selected" : ""} onClick={() => onReadingPrefsChange({ ...prefs, lineHeight: item.id })}>{item.label}</button>
              ))}
              <span>栏宽</span>
              {measureOptions.map((item) => (
                <button key={item.id} type="button" className={prefs.measure === item.id ? "selected" : ""} onClick={() => onReadingPrefsChange({ ...prefs, measure: item.id })}>{item.label}</button>
              ))}
            </div>
            <div className="tool-row">
              <span>朗读</span>
              {listenRateOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={Number(prefs.listenRate) === item.id ? "selected" : ""}
                  onClick={() => onReadingPrefsChange({ ...prefs, listenRate: item.id })}
                >
                  {item.label}
                </button>
              ))}
              <button type="button" onClick={toggleHighlight} disabled={!selectedWord?.keys?.length} className={selectedIsMarked ? "selected" : ""}>
                <Highlighter size={16} />划线
              </button>
              <button type="button" onClick={() => copySentence()} disabled={!selectedWord?.sentence}><Copy size={16} />{copied || "复制"}</button>
              <button type="button" onClick={() => listenFromSentence(selectedWord.sentenceKey)} disabled={!selectedWord?.sentenceKey}><SpeakerHigh size={16} />从此句朗读</button>
              <button type="button" onClick={saveSelectedWord} disabled={!selectedWord?.result}><BookmarkSimple size={16} />收藏</button>
            </div>
          </div>
        )}
        <article
          ref={scrollRef}
          className={`reader-scroll${toolsOpen ? " tools-open" : ""}${findOpen ? " find-open" : ""}${listenDock ? " listen-open" : ""}`}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            const node = event.target.closest("[data-word-key]");
            if (!node) return;
            const unit = node.closest(".sentence-unit");
            if (!unit) return;
            pickRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              unit,
              startKey: node.dataset.wordKey,
              keys: [node.dataset.wordKey],
              dragging: false,
              scrolling: false,
            };
          }}
          onPointerMove={(event) => {
            const pick = pickRef.current;
            if (!pick || event.pointerId !== pick.pointerId || pick.scrolling) return;
            const dx = event.clientX - pick.x;
            const dy = event.clientY - pick.y;
            if (!pick.dragging && Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) + 4) {
              pick.scrolling = true;
              return;
            }
            if (Math.hypot(dx, dy) < 10) return;
            pick.dragging = true;
            try {
              event.currentTarget.setPointerCapture(pick.pointerId);
            } catch {
              /* capture is optional */
            }
            const node = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-word-key]");
            if (!node) return;
            const unit = node.closest(".sentence-unit");
            if (unit !== pick.unit) return;
            const keys = keysInRange(unit, pick.startKey, node.dataset.wordKey);
            if (keys.length < 2 || keys.join() === pick.keys.join()) return;
            pick.keys = keys;
            setSelectedWord({ ...wordContextFromUnit(unit, keys), status: "picking", result: null, error: "" });
          }}
          onPointerUp={finishPick}
          onPointerCancel={finishPick}
          onClick={(event) => {
            if (!clickKeepsAnnotation(event.target)) {
              wordRequestRef.current?.abort();
              setSelectedWord(null);
            }
          }}
          onScroll={(event) => {
            if (!restoredProgress.current || applyingScrollRef.current) return;
            const element = event.currentTarget;
            const ratio = element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
            if (Math.abs(ratio - currentChapterProgress) <= 0.05) return;
            userMovedRef.current = true;
            const chapterProgress = Math.min(1, Math.max(0, ratio));
            reportProgress(chapterOverallProgress(chapters, activeChapterId, chapterProgress), chapterProgress);
          }}
        >
          <div className="reader-title-block"><span>{article.topic ?? "本地内容"} · {article.cefr}</span><h1>{article.title}</h1>{chapters.length > 1 && <p>{activeChapter?.title}</p>}</div>
          {paragraphs.map((paragraph, paragraphIndex) => {
            const sentences = splitSentences(paragraph);
            const previousSentences = paragraphIndex > 0 ? splitSentences(paragraphs[paragraphIndex - 1]) : [];
            const nextSentences = paragraphIndex < paragraphs.length - 1 ? splitSentences(paragraphs[paragraphIndex + 1]) : [];
            return (
              <p
                className="reader-paragraph"
                data-paragraph={paragraphIndex}
                key={`${article.id}-${activeChapterId}-${paragraphIndex}`}
              >
                {sentences.map((sentence, sentenceIndex) => {
                  const sentenceKey = withChapterKey(`${paragraphIndex}-${sentenceIndex}`, activeChapterId);
                  const { body: sentenceBody, ending: sentenceEnding } = splitSentenceEnding(sentence);
                  const before = sentences[sentenceIndex - 1] ?? previousSentences.at(-1) ?? "";
                  const after = sentences[sentenceIndex + 1] ?? nextSentences[0] ?? "";
                  return (
                    <span
                      className={`sentence-unit${listenKey === sentenceKey ? " speaking" : ""}`}
                      key={sentenceKey}
                      data-sentence={sentence}
                      data-before={before}
                      data-after={after}
                      data-sentence-key={sentenceKey}
                    >
                      <span className="sentence-text">
                        {(() => {
                          const items = annotateTokens(tokenizeSentence(sentenceBody), sentenceKey);
                          const span = selectedWord?.sentenceKey === sentenceKey && selectedWord?.keys
                            ? selectionSpan(items, selectedWord.keys)
                            : null;
                          const collapsing = Boolean(
                            span
                            && span.end > span.start
                            && selectedWord?.status
                            && selectedWord.status !== "picking"
                          );
                          const skipMarked = new Set();
                          const markedSpans = [];
                          if (!collapsing) {
                            items.forEach((_, tokenIndex) => {
                              if (skipMarked.has(tokenIndex)) return;
                              const run = markedRun(items, tokenIndex, markedKeys);
                              if (!run) return;
                              markedSpans.push(run);
                              for (let index = run.start + 1; index <= run.end; index += 1) skipMarked.add(index);
                            });
                          }
                          return items.map((item, tokenIndex) => {
                            if (collapsing && tokenIndex > span.start && tokenIndex <= span.end) return null;
                            if (collapsing && tokenIndex === span.start) {
                              const slice = items.slice(span.start, span.end + 1);
                              const context = {
                                word: phraseFromItems(items, span) || item.token,
                                sentence,
                                before,
                                after,
                                key: item.key,
                                keys: slice.filter((entry) => entry.word).map((entry) => entry.key),
                                sentenceKey,
                              };
                              return (
                                <PhraseCluster
                                  key={item.key}
                                  items={slice}
                                  status={selectedWord.status}
                                  result={selectedWord.result}
                                  marked={slice.some((entry) => markedKeys.has(entry.key))}
                                  saved={selectedIsSaved}
                                  actionMarked={selectedIsMarked}
                                  onSelect={() => handleWord(context)}
                                  onRetry={() => requestWord(selectedWord)}
                                  onSave={(event) => {
                                    event.stopPropagation();
                                    saveSelectedWord();
                                  }}
                                  onHighlight={(event) => {
                                    event.stopPropagation();
                                    toggleHighlight();
                                  }}
                                />
                              );
                            }
                            if (skipMarked.has(tokenIndex)) return null;
                            const run = markedSpans.find((entry) => entry.start === tokenIndex);
                            if (run) {
                              return (
                                <MarkedCluster
                                  key={item.key}
                                  items={items.slice(run.start, run.end + 1)}
                                  hitSet={hitSet}
                                  currentHitSet={currentHitSet}
                                  savedSet={savedSet}
                                  onSelect={(entry) => handleWord({
                                    word: entry.token,
                                    sentence,
                                    before,
                                    after,
                                    key: entry.key,
                                    keys: [entry.key],
                                    sentenceKey,
                                  })}
                                />
                              );
                            }
                            if (!item.word) return <span key={item.key}>{item.token}</span>;
                            const context = {
                              word: item.token,
                              sentence,
                              before,
                              after,
                              key: item.key,
                              keys: [item.key],
                              sentenceKey,
                            };
                            const inSpan = Boolean(span && tokenIndex >= span.start && tokenIndex <= span.end);
                            const single = selectedWord?.keys?.length === 1 && selectedWord.keys[0] === item.key;
                            return (
                              <WordUnit
                                key={item.key}
                                surface={item.token}
                                item={item}
                                selected={single && selectedWord.status !== "picking"}
                                highlighted={inSpan}
                                marked={markedKeys.has(item.key)}
                                saved={savedSet.has(item.word)}
                                hit={hitSet.has(item.key)}
                                current={currentHitSet.has(item.key)}
                                status={single ? selectedWord.status : ""}
                                result={single ? selectedWord.result : null}
                                onSelect={() => handleWord(context)}
                                onRetry={() => requestWord(context)}
                                actionSaved={selectedIsSaved}
                                actionMarked={selectedIsMarked}
                                onSave={(event) => {
                                  event.stopPropagation();
                                  saveSelectedWord();
                                }}
                                onHighlight={(event) => {
                                  event.stopPropagation();
                                  toggleHighlight();
                                }}
                              />
                            );
                          });
                        })()}
                      </span>
                      {"\u2060"}
                      <button
                        className={selectedSentence === sentenceKey ? "sentence-dot active" : "sentence-dot"}
                        onClick={() => handleSentence({ sentence, before, after, key: sentenceKey })}
                        aria-label="显示或隐藏整句翻译"
                        aria-pressed={selectedSentence === sentenceKey}
                      ><span aria-hidden="true">{sentenceEnding}</span></button>
                      {" "}
                      {selectedSentence === sentenceKey && (
                        <span className={`sentence-translation ${sentenceResult?.status ?? "loading"}`} role="status" aria-live="polite">
                          {sentenceResult?.status === "error" ? (
                            <><span>{sentenceResult.error}</span><button onClick={() => requestSentence(sentenceResult)}>重试</button></>
                          ) : sentenceResult?.translation}
                          {sentenceResult?.status === "success" && (
                            <button type="button" className="sentence-copy" onClick={() => copySentence(sentence)} aria-label="复制原句"><Copy size={14} /></button>
                          )}
                        </span>
                      )}
                    </span>
                  );
                })}
              </p>
            );
          })}
          {chapters.length > 1 && (
            <nav className="chapter-pager" aria-label="切换章节">
              <button type="button" disabled={activeChapterIndex === 0} onClick={() => changeChapter(chapters[activeChapterIndex - 1]?.id)}>上一章</button>
              <span>{activeChapterIndex + 1} / {chapters.length}</span>
              <button type="button" disabled={activeChapterIndex === chapters.length - 1} onClick={() => changeChapter(chapters[activeChapterIndex + 1]?.id)}>下一章</button>
            </nav>
          )}
          {activeChapterIndex === chapters.length - 1 && (
            <ReadingCompletion
              article={article}
              vocabularyCount={articleWords.length}
              feedback={feedback}
              onFeedback={onFeedback}
              onReview={onReview}
              onAdjustLevel={onAdjustLevel}
              onBack={onBack}
            />
          )}
        </article>
      </section>
      <aside className="reader-study-panel">
        <span className="context-kicker">THIS PIECE</span>
        <h2>{article.title}</h2>
        {selectedWord?.status === "loading" && <div className="study-loading">翻译中…</div>}
        {selectedWord?.status === "error" && (
          <div className="study-error">
            <strong>{selectedWord.word}</strong>
            <p>{selectedWord.error}</p>
            <button onClick={() => requestWord(selectedWord)}>重新翻译</button>
          </div>
        )}
        {selectedWord?.result && (
          <div className="study-word-card">
            <div><strong>{selectedWord.word}</strong><span>{selectedWord.result.phonetic}</span></div>
            <em>{isReferentGloss(selectedWord.result) ? glossText(selectedWord.result) : `语境义 ${selectedWord.result.translation}`}</em>
            {hasCommonGloss(selectedWord.result) && (
              <p className="study-common">常见义 {selectedWord.result.commonTranslation}</p>
            )}
            <dl>
              <div><dt>原形</dt><dd>{selectedWord.result.lemma || "—"}</dd></div>
              <div><dt>词性</dt><dd>{selectedWord.result.partOfSpeech || "—"}</dd></div>
            </dl>
            <p>{selectedWord.sentence}</p>
            <div className="study-actions">
              <button type="button" onClick={toggleHighlight} className={selectedIsMarked ? "selected" : ""}><Highlighter size={18} />划线</button>
              <button type="button" onClick={() => copySentence()}><Copy size={18} />{copied || "复制"}</button>
              <button onClick={saveSelectedWord} disabled={selectedIsSaved}>
                <BookmarkSimple size={18} />{selectedIsSaved ? "已收藏" : "收藏"}
              </button>
            </div>
            {selectedWord?.sentenceKey && (
              <button type="button" className="source-link" onClick={() => listenFromSentence(selectedWord.sentenceKey)}>
                从此句朗读
              </button>
            )}
          </div>
        )}
        {!selectedWord && (
          <>
            <div className="study-recent">
              <span>划线</span>
              {articleHighlights.map((item) => (
                <button type="button" className="study-jump" key={item.id} onClick={() => {
                  const key = item.chapterId ? withChapterKey(item.keys?.[0], item.chapterId) : legacyLocationKeyForDocument(article, item.keys?.[0]);
                  jumpToKey(key, chapterIdFromKey(key) || activeChapterId);
                }}>
                  <strong>{item.word}</strong>
                  <span>{item.sentence}</span>
                </button>
              ))}
            </div>
            <div className="study-recent">
              <span>生词</span>
              {articleWords.map((item) => (
                <button
                  type="button"
                  className="study-jump"
                  key={item.id}
                  onClick={() => setInternalFocus(item)}
                >
                  <strong>{item.word}</strong>
                  <span>{glossText(item)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
