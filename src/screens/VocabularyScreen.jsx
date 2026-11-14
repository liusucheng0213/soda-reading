import { useMemo, useState } from "react";
import { BookmarkSimple, X } from "@phosphor-icons/react";
import { dueCards, dueVocabulary, learningVocabulary, masteredVocabulary, setVocabularyLearningState } from "@soda-reading/core";
import { glossText, vocabSource } from "../lib/study.js";
import { ReviewSession } from "./ReviewSession.jsx";

export function VocabularyScreen({ items, catalog = [], reviewLimit = 20, onChange, onReview, onOpen, reviewing, onReviewingChange, sessionItems, reviewFilterId, onClearReviewFilter }) {
  const [sessionId, setSessionId] = useState(0);
  const [view, setView] = useState("learning");
  const reviewPool = sessionItems ?? items;
  const learning = useMemo(() => learningVocabulary(items), [items]);
  const mastered = useMemo(() => masteredVocabulary(items), [items]);
  const allDue = useMemo(() => dueVocabulary(items), [items]);
  const batch = useMemo(() => dueCards(reviewPool, reviewLimit), [reviewPool, reviewLimit]);
  const remainingDue = dueVocabulary(reviewPool).length;

  const startBatch = () => {
    setSessionId((value) => value + 1);
    onReviewingChange(true);
  };

  if (reviewing) {
    return (
      <ReviewSession
        key={sessionId}
        items={reviewPool}
        reviewLimit={reviewLimit}
        onReview={onReview}
        onExit={() => onReviewingChange(false)}
        onNextBatch={startBatch}
        remainingDue={remainingDue}
        onOpen={onOpen}
        catalog={catalog}
      />
    );
  }

  const visibleItems = view === "learning" ? learning : mastered;
  const restore = (item) => {
    onChange(items.map((entry) => entry.id === item.id ? setVocabularyLearningState(entry, "learning") : entry));
  };

  return (
    <section className="screen vocabulary-screen">
      <header className="screen-header"><div><span className="eyebrow">WORDS</span><h1>生词本</h1></div><span className="count-label">{visibleItems.length}</span></header>
      {items.length > 0 && (
        <div className="vocabulary-view-switch" aria-label="生词视图">
          <button type="button" aria-pressed={view === "learning"} onClick={() => setView("learning")}>学习中 {learning.length}</button>
          <button type="button" aria-pressed={view === "mastered"} onClick={() => setView("mastered")}>已掌握 {mastered.length}</button>
        </div>
      )}
      {view === "learning" && learning.length > 0 && (
        <div className="review-entry">
          <div><strong>{allDue.length} 张待复习</strong><span>本批 {batch.length} 张 · 每张卡独立安排复习时间</span></div>
          <button onClick={startBatch} disabled={!batch.length}>{batch.length ? "开始本批复习" : "暂无到期"}</button>
        </div>
      )}
      {reviewFilterId && view === "learning" && <p className="inline-status">本轮优先复习当前文章的生词。<button className="text-button" onClick={onClearReviewFilter}>查看全部</button></p>}
      {items.length === 0 ? (
        <div className="empty-state"><BookmarkSimple size={42} weight="thin" /><h3>还没有生词</h3><p>阅读时点击单词，译义出现后选择“收藏”。</p></div>
      ) : visibleItems.length === 0 ? (
        <div className="empty-state compact"><h3>{view === "learning" ? "学习库为空" : "还没有已掌握的生词"}</h3><p>{view === "learning" ? "阅读时收藏需要学习的词语。" : "复习时可以把无需再复习的词移到这里。"}</p></div>
      ) : (
        <div className="word-list">
          {visibleItems.map((item) => {
            const source = vocabSource(catalog, item);
            return (
              <article className="saved-word" key={item.id}>
                <button className="delete-word" aria-label={`删除 ${item.word}`} onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}><X size={18} /></button>
                <strong lang="en">{item.word}</strong><span>{item.phonetic}</span><em>{glossText(item)}</em><p lang="en">{item.sentence}</p>
                <div className="saved-word-actions">
                  {source && (
                    <button type="button" className="source-link" onClick={() => onOpen(source, { word: item.word, sentence: item.sentence, chapterId: item.chapterId })}>原文</button>
                  )}
                  {view === "mastered" && <button type="button" className="source-link" onClick={() => restore(item)}>恢复复习</button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
