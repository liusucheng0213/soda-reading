import { useEffect, useState } from "react";
import { BookOpenText } from "@phosphor-icons/react";
import { levelOptions, topicOptions } from "../data.js";

const FORM_OPTIONS = [
  { value: "story", label: "故事" },
  { value: "science", label: "科普" },
  { value: "explainer", label: "说明" },
];

const LENGTH_OPTIONS = [
  { value: "short", label: "短一点" },
  { value: "medium", label: "适中" },
  { value: "long", label: "长一点" },
];

export function DailyAiPanel({ profile, state, onGenerate, onOpen }) {
  const [preferences, setPreferences] = useState(() => ({
    interest: profile.topics?.[0] || "科技",
    form: "science",
    length: "medium",
    cefr: profile.level || "B1",
  }));
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState("");
  const status = state?.status || "empty";
  const article = state?.article;

  useEffect(() => {
    setPreferences((current) => ({ ...current, cefr: profile.level || "B1" }));
  }, [profile.level]);

  useEffect(() => {
    if (profile.topics?.[0]) {
      setPreferences((current) => ({ ...current, interest: profile.topics[0] }));
    }
  }, [profile.topics?.[0]]);

  const update = (field) => (event) => {
    setPreferences((current) => ({ ...current, [field]: event.target.value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    if (pending || status !== "empty") return;
    setPending(true);
    setRequestError("");
    try {
      await onGenerate(preferences);
    } catch {
      setRequestError("连接暂时中断，请刷新查看今日状态；普通阅读不受影响。");
    } finally {
      setPending(false);
    }
  };

  if (status === "ready" && article) {
    return (
      <section className="daily-ai-panel ready" aria-labelledby="daily-ai-title">
        <div className="article-meta"><span>今日 AI 文章</span><span>{article.cefr} · {article.readingMinutes} 分钟</span></div>
        <h2 id="daily-ai-title">{article.title}</h2>
        <p>{article.introZh || article.summary}</p>
        <div className="source-line"><span>基于 {article.sources?.length || 0} 个可靠来源生成</span></div>
        <button className="reading-cta" type="button" onClick={() => onOpen(article)}>
          开始阅读 <BookOpenText size={20} />
        </button>
      </section>
    );
  }

  if (status === "failed") {
    return (
      <section className="daily-ai-panel" aria-labelledby="daily-ai-title">
        <div className="article-meta"><span>今日 AI 文章</span></div>
        <h2 id="daily-ai-title">今天先读精选文章</h2>
        <p role="status">可用资料不足或模型暂时不可用，已为你保留下面的今日阅读。</p>
      </section>
    );
  }

  const busy = pending || status === "generating";
  return (
    <section className="daily-ai-panel" aria-labelledby="daily-ai-title">
      <div className="article-meta"><span>今日 AI 文章</span><span>每天一篇</span></div>
      <h2 id="daily-ai-title">为今天选一篇新文章</h2>
      <form onSubmit={submit}>
        <div className="daily-ai-settings">
          <label>兴趣
            <select name="interest" value={preferences.interest} onChange={update("interest")} disabled={busy}>
              {topicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
            </select>
          </label>
          <label>形式
            <select name="form" value={preferences.form} onChange={update("form")} disabled={busy}>
              {FORM_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>篇幅
            <select name="length" value={preferences.length} onChange={update("length")} disabled={busy}>
              {LENGTH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>CEFR
            <select name="cefr" value={preferences.cefr} onChange={update("cefr")} disabled={busy}>
              {levelOptions.map((option) => <option key={option.id} value={option.id}>{option.id}</option>)}
            </select>
          </label>
        </div>
        <button className="primary-button daily-ai-submit" type="submit" disabled={busy}>
          {busy ? "正在生成…" : "确认生成"}
        </button>
      </form>
      <p className="daily-ai-note">确认后才会检索资料并生成；刷新不会重复生成。</p>
      {requestError && <p className="inline-status error" role="status">{requestError}</p>}
    </section>
  );
}
