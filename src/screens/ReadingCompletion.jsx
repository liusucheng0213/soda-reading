import { levelOptions } from "../data.js";

export function ReadingCompletion({ article, vocabularyCount, feedback, onFeedback, onReview, onAdjustLevel, onBack }) {
  const index = levelOptions.findIndex((option) => option.id === article.cefr);
  const target = feedback === "hard" ? levelOptions[index - 1] : feedback === "easy" ? levelOptions[index + 1] : null;
  return (
    <section className="reading-completion" aria-labelledby="reading-completion-title">
      <span className="eyebrow">FINISH & REVIEW</span>
      <h2 id="reading-completion-title">读完以后，检查一下自己的感受</h2>
      <p>本文收藏了 {vocabularyCount} 个生词。复习和难度感受会帮助你选择下一篇材料。</p>
      <div className="completion-actions">
        <button type="button" disabled={!vocabularyCount} onClick={() => onReview(article.id)}>复习本文 {vocabularyCount} 个生词</button>
        <button type="button" onClick={onBack}>返回今日</button>
      </div>
      <div className="completion-feedback" role="group" aria-label="本文难度感受">
        <button type="button" aria-pressed={feedback === "easy"} onClick={() => onFeedback("easy")}>太简单</button>
        <button type="button" aria-pressed={feedback === "right"} onClick={() => onFeedback("right")}>刚好</button>
        <button type="button" aria-pressed={feedback === "hard"} onClick={() => onFeedback("hard")}>太难</button>
      </div>
      {target && (
        <p className="completion-suggestion">这篇对你来说{feedback === "hard" ? "偏难" : "偏易"}。要调整为 {target.id} 吗？
          <button type="button" className="text-button" onClick={() => onAdjustLevel(target.id)}>采用 {target.id}</button>
        </p>
      )}
    </section>
  );
}
