import { useMemo, useState } from "react";
import { BookmarkSimple, X } from "@phosphor-icons/react";
import { dueCards } from "@soda-reading/core";
import { glossText, vocabSource } from "../lib/study.js";
import { ReviewSession } from "./ReviewSession.jsx";

export function VocabularyScreen({ items, catalog = [], reviewLimit = 20, onChange, onReview, onOpen, reviewing, onReviewingChange, sessionItems, reviewFilterId, onClearReviewFilter }) {
  const [sessionId, setSessionId] = useState(0);
  const queue = useMemo(() => dueCards(items, reviewLimit), [items, reviewLimit]);

  if (reviewing) {
    return (
      <ReviewSession
        key={sessionId}
        items={sessionItems ?? items}
        reviewLimit={reviewLimit}
        onReview={onReview}
        onExit={() => onReviewingChange(false)}
        onOpen={onOpen}
        catalog={catalog}
      />
    );
  }

  return (
    <section className="screen vocabulary-screen">
      <header className="screen-header"><div><span className="eyebrow">WORDS</span><h1>生词本</h1></div><span className="count-label">{items.length}</span></header>
      {items.length > 0 && (
        <div className="review-entry">
          <div><strong>{queue.length} 张待复习</strong></div>
          <button onClick={() => { setSessionId((value) => value + 1); onReviewingChange(true); }} disabled={!queue.length}>{queue.length ? "开始复习" : "今天已完成"}</button>
        </div>
      )}
      {reviewFilterId && <p className="inline-status">本轮优先复习当前文章的生词。<button className="text-button" onClick={onClearReviewFilter}>查看全部</button></p>}
      {items.length === 0 ? (
        <div className="empty-state"><BookmarkSimple size={42} weight="thin" /><h3>还没有生词</h3><p>阅读时点击单词，译义出现后选择“收藏”。</p></div>
      ) : (
        <div className="word-list">
          {items.map((item) => {
            const source = vocabSource(catalog, item);
            return (
              <article className="saved-word" key={item.id}>
                <button aria-label={`删除 ${item.word}`} onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}><X size={18} /></button>
                <strong>{item.word}</strong><span>{item.phonetic}</span><em>{glossText(item)}</em><p>{item.sentence}</p>
                {source && (
                  <button type="button" className="source-link" onClick={() => onOpen(source, { word: item.word, sentence: item.sentence, chapterId: item.chapterId })}>原文</button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
