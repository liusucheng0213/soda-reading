import { useId, useState } from "react";

const OPTION_LETTERS = ["A", "B", "C", "D"];

export function ExamPractice({ article }) {
  const prefix = useId();
  const [answers, setAnswers] = useState({});
  const [checked, setChecked] = useState({});
  const questions = Array.isArray(article?.questions) ? article.questions : [];
  if (!article?.examTrack || questions.length === 0) return null;

  const choose = (questionId, letter) => {
    setAnswers((current) => ({ ...current, [questionId]: letter }));
    setChecked((current) => ({ ...current, [questionId]: false }));
  };

  return (
    <section className="exam-practice" aria-labelledby={`${prefix}-title`}>
      <header className="exam-practice-header">
        <span className="eyebrow">READING PRACTICE</span>
        <h2 id={`${prefix}-title`}>读后练习</h2>
        <p>选择答案后核对，再看解析和原文依据。</p>
      </header>
      {questions.map((question, questionIndex) => {
        const selected = answers[question.id];
        const revealed = checked[question.id] === true;
        const answerIndex = OPTION_LETTERS.indexOf(question.answer);
        const resultId = `${prefix}-${questionIndex}-result`;
        return (
          <fieldset className="exam-question" key={question.id}>
            <legend><span>{questionIndex + 1}.</span>{question.prompt}</legend>
            <div className="exam-options">
              {question.options.map((option, optionIndex) => {
                const letter = OPTION_LETTERS[optionIndex];
                const id = `${prefix}-${questionIndex}-${optionIndex}`;
                return (
                  <div className="exam-option" key={letter}>
                    <input
                      id={id}
                      type="radio"
                      name={`${prefix}-${question.id}`}
                      value={letter}
                      checked={selected === letter}
                      onChange={() => choose(question.id, letter)}
                      aria-describedby={revealed ? resultId : undefined}
                    />
                    <label htmlFor={id}><span>{letter}.</span>{option}</label>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="exam-check"
              disabled={!selected}
              onClick={() => setChecked((current) => ({ ...current, [question.id]: true }))}
            >
              核对答案
            </button>
            {revealed && (
              <div className="exam-result" id={resultId} role="status" aria-live="polite">
                <strong>{selected === question.answer ? "回答正确" : "回答错误"}</strong>
                <p>正确答案：{question.answer}. {question.options[answerIndex]}</p>
                <div className="exam-explanation"><span>解析</span><p>{question.explanationZh}</p></div>
                <blockquote className="exam-evidence">
                  <span>原文依据 · 第 {question.evidenceParagraph + 1} 段</span>
                  <p lang="en">{question.evidenceSentence}</p>
                </blockquote>
              </div>
            )}
          </fieldset>
        );
      })}
    </section>
  );
}
