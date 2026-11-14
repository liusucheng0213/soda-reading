import { useEffect, useMemo, useState } from "react";
import { SpeakerHigh } from "@phosphor-icons/react";
import { currentReviewItem, masterSessionCard, REVIEW_RATINGS, rateSessionCard, startReviewSession, undoReviewSession } from "@soda-reading/core";
import { glossText, vocabSource } from "../lib/study.js";

const CONFIRM_LABELS = { again: "记错", hard: "困难", good: "正确", easy: "轻松" };

export function ReviewSession({ items, reviewLimit = 20, onReview, onExit, onOpen, catalog, onNextBatch, remainingDue = 0 }) {
  const [session, setSession] = useState(() => startReviewSession(items, reviewLimit));
  const [phase, setPhase] = useState("recall");
  const current = currentReviewItem(session);
  const currentSource = useMemo(() => vocabSource(catalog, current), [catalog, current]);

  const advance = (result) => {
    onReview(result.item, null, result.afterItem);
    setSession(result.session);
    setPhase("recall");
  };

  const rate = (rating) => {
    if (!current) return;
    advance(rateSessionCard(session, rating));
  };

  const master = () => {
    if (!current) return;
    advance(masterSessionCard(session));
  };

  const undo = () => {
    const result = undoReviewSession(session);
    if (!result) return;
    onReview(result.item, null, result.beforeItem);
    setSession(result.session);
    setPhase("recall");
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
      if (event.isComposing || target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      const isSpace = event.key === " " || event.code === "Space";
      if (isSpace && target?.closest?.("button, a")) return;
      if (phase === "recall") {
        if (isSpace) {
          event.preventDefault();
          setPhase("confirm");
        } else if (event.key === "1") {
          event.preventDefault();
          setPhase("unknown");
        }
        return;
      }
      if (phase === "confirm" && ["1", "2", "3", "4"].includes(event.key)) {
        event.preventDefault();
        rate(REVIEW_RATINGS[Number(event.key) - 1].id);
        return;
      }
      if (phase === "unknown" && (isSpace || event.key === "1")) {
        event.preventDefault();
        rate(REVIEW_RATINGS[0].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session, phase, current]);

  if (!current) {
    return (
      <section className="screen vocabulary-screen review-session">
        <header className="screen-header"><div><span className="eyebrow">REVIEW</span><h1>本批完成</h1></div></header>
        <div className="empty-state">
          <h3>这批生词复习完了</h3>
          <p>{remainingDue > 0 ? `还有 ${remainingDue} 张到期生词，可以继续下一批。` : "之后有新的到期生词，再来复习即可。"}</p>
          {remainingDue > 0 && onNextBatch && <button className="primary-button" onClick={onNextBatch}>复习下一批</button>}
          <button className="text-button" onClick={onExit}>回到生词本</button>
          <button type="button" className="text-button review-completion-undo" onClick={undo} disabled={!session.history.length}>撤销最近操作 <small>Ctrl+Z</small></button>
        </div>
      </section>
    );
  }

  const revealed = phase !== "recall";
  return (
    <section className="screen vocabulary-screen review-session">
      <header className="screen-header">
        <div><span className="eyebrow">REVIEW</span><h1>今日复习</h1></div>
        <button className="text-button" onClick={onExit}>退出</button>
      </header>
      <div className="review-progress-line">
        <span>已完成 {session.completed} / {session.total}</span>
        <span>本批还剩 {session.queue.length} 张</span>
      </div>
      <progress className="review-progress" value={session.completed} max={session.total} aria-label="复习进度" />
      <article className="review-card">
        <button className="pronounce-button" onClick={speak} aria-label={`朗读 ${current.word}`}><SpeakerHigh size={21} /></button>
        <strong lang="en">{current.word}</strong>
        <span className="review-phonetic">{current.phonetic}</span>
        <p lang="en">{current.sentence}</p>
        {phase === "recall" && (
          <div className="review-recall">
            <p>先回想这个词在这里的意思，再选择。</p>
            <button className="primary-button" onClick={() => setPhase("confirm")}>认识 <small>空格</small></button>
            <button className="text-button" onClick={() => setPhase("unknown")}>不认识 <small>1</small></button>
          </div>
        )}
        {revealed && (
          <div className="review-answer" aria-live="polite">
            <em>{glossText(current)}</em>
            {current.commonTranslation && current.commonTranslation !== current.translation && <span>常见义 {current.commonTranslation}</span>}
          </div>
        )}
        {phase === "confirm" && (
          <div className="review-ratings" aria-label="确认自己的记忆判断">
            {REVIEW_RATINGS.map((rating, index) => (
              <button key={rating.id} onClick={() => rate(rating.id)} className={`rating-${rating.key}`}>{CONFIRM_LABELS[rating.key]}<small>{index + 1}</small></button>
            ))}
          </div>
        )}
        {phase === "unknown" && (
          <div className="review-unknown">
            <p>这张会在本批稍后再次出现。</p>
            <button className="primary-button" onClick={() => rate(REVIEW_RATINGS[0].id)}>继续本轮 <small>1 / 空格</small></button>
          </div>
        )}
        {revealed && (
          <div className="review-answer-actions">
            <button type="button" className="text-button" onClick={master}>移入已掌握</button>
            {currentSource && (
              <button type="button" className="source-link" onClick={() => onOpen(currentSource, { word: current.word, sentence: current.sentence, chapterId: current.chapterId })}>原文</button>
            )}
          </div>
        )}
      </article>
      <div className="review-session-tools">
        <span className="review-shortcuts">{phase === "recall" ? "空格 认识 · 1 不认识" : phase === "confirm" ? "1–4 确认记忆评价" : "空格或 1 继续"}</span>
        <button type="button" className="text-button" onClick={undo} disabled={!session.history.length}>撤销 <small>Ctrl+Z</small></button>
      </div>
    </section>
  );
}
