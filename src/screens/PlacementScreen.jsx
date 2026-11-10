import { useState } from "react";
import { levelOptions } from "../data.js";
import { placementQuestions } from "../data/placementQuestions.js";
import { scorePlacement } from "../lib/placement.js";

export function PlacementScreen({ onComplete, onCancel }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [selected, setSelected] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState(null);
  const question = placementQuestions[index];

  const advance = (answer) => {
    const nextAnswers = { ...answers, [question.id]: answer };
    setAnswers(nextAnswers);
    if (index === placementQuestions.length - 1) {
      setResult(scorePlacement(nextAnswers, placementQuestions));
      return;
    }
    setIndex((current) => current + 1);
    setSelected("");
    setSubmitted(false);
  };

  if (result) {
    const level = levelOptions.find((option) => option.id === result.level);
    return (
      <main className="entry-shell placement-screen">
        <span className="brand-kicker">READING LEVEL</span>
        <h1>你的起步阅读水平</h1>
        <div className="placement-result"><strong>{result.level}</strong><span>{level?.label}</span></div>
        <p>答对 {result.correct} / {placementQuestions.length} 题。{result.caveat}</p>
        <ul className="placement-breakdown">
          {Object.entries(result.perLevel).map(([id, stats]) => (
            <li key={id}><strong>{id}</strong><span>{stats.correct} / {stats.total} 题正确</span></li>
          ))}
        </ul>
        <button type="button" className="primary-button" onClick={() => onComplete(result)}>采用这个水平</button>
        <button type="button" className="text-button" onClick={() => {
          setResult(null);
          setIndex(0);
          setAnswers({});
          setSelected("");
          setSubmitted(false);
        }}>重新测一次</button>
      </main>
    );
  }

  return (
    <main className="entry-shell placement-screen">
      <header className="setup-header"><span>阅读评估</span><strong>大致水平测试</strong></header>
      <div className="placement-progress"><progress value={index + 1} max={placementQuestions.length} aria-label="测试进度" /><span>{index + 1} / {placementQuestions.length}</span></div>
      <p className="placement-kind">{question.level} · {question.kind}</p>
      <p className="placement-context" lang="en">{question.context}</p>
      <h2>{question.prompt}</h2>
      <div className="placement-choices">
        {question.choices.map((choice) => (
          <button
            type="button"
            key={choice}
            className={selected === choice ? "selected" : ""}
            aria-pressed={selected === choice}
            disabled={submitted}
            onClick={() => setSelected(choice)}
          >{choice}</button>
        ))}
      </div>
      {submitted && (
        <div className={`placement-explanation ${selected === question.answer ? "correct" : "incorrect"}`} role="status">
          <strong>{selected === question.answer ? "回答正确" : `正确答案：${question.answer}`}</strong>
          <p>{question.explanation}</p>
        </div>
      )}
      {!submitted ? (
        <button type="button" className="primary-button" disabled={!selected} onClick={() => setSubmitted(true)}>提交答案</button>
      ) : (
        <button type="button" className="primary-button" onClick={() => advance(selected)}>{index === placementQuestions.length - 1 ? "查看结果" : "下一题"}</button>
      )}
      <div className="placement-secondary">
        <button type="button" className="text-button" onClick={() => advance(null)} disabled={submitted}>跳过本题</button>
        <button type="button" className="text-button" onClick={onCancel}>暂不测试</button>
      </div>
    </main>
  );
}
