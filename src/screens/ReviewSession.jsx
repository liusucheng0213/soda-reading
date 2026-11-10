import { useEffect, useMemo, useState } from "react";
import { SpeakerHigh } from "@phosphor-icons/react";
import { currentReviewItem, REVIEW_RATINGS, rateSessionCard, startReviewSession, undoReviewSession } from "@soda-reading/core";
import { glossText, vocabSource } from "../lib/study.js";

export function ReviewSession({ items, reviewLimit = 20, onReview, onExit, onOpen, catalog }) {
  const [session, setSession] = useState(() => startReviewSession(items, reviewLimit));
  const [revealed, setRevealed] = useState(false);
  const current = currentReviewItem(session);
  const currentSource = useMemo(() => vocabSource(catalog, current), [catalog, current]);

  const rate = (rating) => {
    if (!current) return;
    const result = rateSessionCard(session, rating);
    onReview(result.item, rating, result.after);
    setSession(result.session);
    setRevealed(false);
  };

  const undo = () => {
    const result = undoReviewSession(session);
    if (!result) return;
    onReview(result.item, null, result.before);
    setSession(result.session);
    setRevealed(false);
  };

  const speak = () => {
    if (!current || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(current.word);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if ((event.key === " " || event.code === "Space") && !revealed) {
        if (target?.closest?.("button, a")) return;
        event.preventDefault();
        setRevealed(true);
        return;
      }
      if (!revealed || !["1", "2", "3", "4"].includes(event.key)) return;
      event.preventDefault();
      rate(REVIEW_RATINGS[Number(event.key) - 1].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session, revealed, current]);

  if (!current) {
    return (
      <section className="screen vocabulary-screen review-session">
        <header className="screen-header"><div><span className="eyebrow">REVIEW</span><h1>本轮完成</h1></div></header>
        <div className="empty-state"><h3>这次复习完成了</h3><p>之后有新的到期生词，再来复习即可。</p><button className="primary-button" onClick={onExit}>回到生词本</button></div>
      </section>
    );
  }

  return (
    <section className="screen vocabulary-screen review-session">
      <header className="screen-header">
        <div><span className="eyebrow">REVIEW</span><h1>今日复习</h1></div>
        <button className="text-button" onClick={onExit}>退出</button>
      </header>
      <div className="review-progress-line">
        <span>已完成 {session.completed} / {session.total}</span>
        <span>队列还剩 {session.queue.length} 张</span>
      </div>
      <progress className="review-progress" value={session.completed} max={session.total} aria-label="复习进度" />
      <article className="review-card">
        <button className="pronounce-button" onClick={speak} aria-label={`朗读 ${current.word}`}><SpeakerHigh size={21} /></button>
        <strong>{current.word}</strong>
        <span className="review-phonetic">{current.phonetic}</span>
        <p>{current.sentence}</p>
        {!revealed ? (
          <button className="primary-button" onClick={() => setRevealed(true)}>显示答案 <small>空格</small></button>
        ) : (
          <div className="review-answer" aria-live="polite">
            <em>{glossText(current)}</em>
            {current.commonTranslation && current.commonTranslation !== current.translation && <span>常见义 {current.commonTranslation}</span>}
          </div>
        )}
        {revealed && (
          <>
            <div className="review-ratings" aria-label="记忆评价">
              {REVIEW_RATINGS.map((rating, index) => (
                <button key={rating.id} onClick={() => rate(rating.id)} className={`rating-${rating.key}`}>{rating.label}<small>{index + 1}</small></button>
              ))}
            </div>
            {currentSource && (
              <button type="button" className="source-link" onClick={() => onOpen(currentSource, { word: current.word, sentence: current.sentence, chapterId: current.chapterId })}>原文</button>
            )}
          </>
        )}
      </article>
      <div className="review-session-tools"><button type="button" className="text-button" onClick={undo} disabled={!session.history.length}>撤销 <small>Ctrl+Z</small></button></div>
    </section>
  );
}
