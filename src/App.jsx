import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpenText,
  Books,
  BookmarkSimple,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Copy,
  FileArrowUp,
  Highlighter,
  House,
  MagnifyingGlass,
  Moon,
  Pause,
  Plus,
  SpeakerHigh,
  Sun,
  TextAa,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import {
  contextualDictionary,
  dailyAlternatives,
  defaultReadingPrefs,
  demoArticle,
  fallbackLibrary,
  levelOptions,
  lineHeightOptions,
  measureOptions,
  themeOptions,
  topicOptions,
  typefaceOptions,
} from "./data.js";
import {
  getDailyFeed,
  changePassword,
  cloudConfigured,
  deleteSyncedVocabulary,
  loadSyncedVocabulary,
  loginWithPassword,
  logout,
  restoreSession,
  reviewSyncedVocabulary,
  saveProfile,
  saveSyncedProgress,
  saveSyncedVocabulary,
  translateSentence,
  translateWord,
} from "./lib/api.js";
import { dueCards, REVIEW_RATINGS, scheduleReview } from "@soda-reading/core";
import { inspectAndParseFile } from "./lib/importers.js";
import {
  annotateTokens,
  normalizeWord,
  phraseFromItems,
  selectionSpan,
  splitSentenceEnding,
  splitSentences,
  tokenizeSentence,
} from "./lib/reader.js";
import { listLocalDocuments, persistState, saveLocalDocument, useStoredState } from "./lib/storage.js";
import { AdminApp } from "./AdminApp.jsx";
import { displayFeed } from "./lib/feed.js";

const NAV_ITEMS = [
  { id: "home", label: "今日", icon: House },
  { id: "library", label: "书架", icon: Books },
  { id: "vocabulary", label: "生词", icon: BookmarkSimple },
  { id: "profile", label: "我的", icon: UserCircle },
];

function hasCommonGloss(result) {
  return Boolean(
    result?.commonTranslation
    && result.commonTranslation !== result.translation
    && !result?.referent,
  );
}

function measureWidth(measure) {
  return measureOptions.find((item) => item.id === measure)?.width ?? "38em";
}

function articleWithBody(article) {
  if (article?.paragraphs?.length) return article;
  return fallbackLibrary.find((item) => item.id === article?.id)
    || fallbackLibrary.find((item) => item.cefr === article?.cefr)
    || article;
}

function speakEnglish(text) {
  if (!text || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  window.speechSynthesis.speak(utterance);
}

function toggleTopic(topics, topic) {
  const current = topics ?? [];
  if (current.includes(topic)) {
    return current.length === 1 ? current : current.filter((item) => item !== topic);
  }
  return [...current, topic].slice(-4);
}

function todayLabel() {
  const today = new Date();
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
  }).format(today);
  const monthDay = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
  }).format(today);
  return `${weekday} · ${monthDay}`;
}

function remainingMinutes(article, progress = 0) {
  const total = Math.max(1, Number(article?.readingMinutes) || 5);
  return Math.max(1, Math.round(total * (1 - Math.min(0.99, progress || 0))));
}

function highlightId(articleId, keys = []) {
  return `${articleId}:${keys.join("-")}`;
}

function freshnessLabel(article) {
  const raw = article.sourcePublishedAt ?? article.publishedAt;
  const published = raw ? new Date(raw) : null;
  if (!published || Number.isNaN(published.getTime())) return "";
  const age = Math.max(0, Math.floor((Date.now() - published.getTime()) / 86_400_000));
  if (age === 0) return "今天";
  if (age === 1) return "昨天";
  if (age < 30) return `${age} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).format(published);
}

function collectFindHits(paragraphs, needle) {
  const query = needle.trim().toLowerCase();
  if (!query) return [];
  const hits = [];
  (paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
    splitSentences(paragraph).forEach((sentence, sentenceIndex) => {
      const { body } = splitSentenceEnding(sentence);
      annotateTokens(tokenizeSentence(body), `${paragraphIndex}-${sentenceIndex}`).forEach((item) => {
        if (!item.word) return;
        if (item.token.toLowerCase().includes(query) || item.word.includes(query)) hits.push(item.key);
      });
    });
  });
  return hits;
}

function usePersistentState(key, fallback) {
  const [value, setValue] = useState(() => useStoredState(key, fallback));
  useEffect(() => persistState(key, value), [key, value]);
  return [value, setValue];
}

export function App() {
  if (import.meta.env.VITE_ADMIN_ONLY === "true") return <AdminApp />;
  if (window.location.pathname.startsWith("/admin") && import.meta.env.VITE_ENABLE_ADMIN === "false") {
    window.location.replace("/");
    return null;
  }
  if (window.location.pathname.startsWith("/admin")) return <AdminApp />;
  return <SodaApp />;
}

function SodaApp() {
  const [session, setSession] = usePersistentState("soda.session", null);
  const [profile, setProfile] = usePersistentState("soda.profile", null);
  const [authReady, setAuthReady] = useState(!cloudConfigured);
  const [syncState, setSyncState] = useState(cloudConfigured ? "正在连接云端…" : "本地开发模式");
  const [theme, setTheme] = usePersistentState("soda.theme", "day");
  const [readingPrefs, setReadingPrefs] = usePersistentState("soda.readingPrefs", defaultReadingPrefs);
  const [resume, setResume] = usePersistentState("soda.resume", null);
  const [screen, setScreen] = useState("home");
  const [activeArticle, setActiveArticle] = useState(null);
  const [feed, setFeed] = useState({ primary: demoArticle, alternatives: dailyAlternatives });
  const [documents, setDocuments] = useState([]);
  const [vocabulary, setVocabulary] = usePersistentState("soda.vocabulary", []);
  const [highlights, setHighlights] = usePersistentState("soda.highlights", []);
  const [progress, setProgress] = usePersistentState("soda.progress", {});
  const [loginHint, setLoginHint] = useState(null);

  useEffect(() => {
    if (!cloudConfigured) return;
    let active = true;
    restoreSession()
      .then((restored) => {
        if (!active) return;
        if (restored) {
          setSession(restored.session);
          setProfile(restored.profile);
          setSyncState("云端已同步");
        } else {
          setSession(null);
          setProfile(null);
          setSyncState("等待登录");
        }
      })
      .catch(() => {
        if (active) {
          setSession(null);
          setProfile(null);
          setSyncState("云端暂时不可用");
        }
      })
      .finally(() => active && setAuthReady(true));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    listLocalDocuments().then(setDocuments).catch(() => setDocuments([]));
  }, []);

  useEffect(() => {
    if (!session?.accessToken || profile?.mustChangePassword) return;
    getDailyFeed(session.accessToken, profile).then(setFeed).catch(() => undefined);
    if (cloudConfigured) {
      loadSyncedVocabulary()
        .then((items) => {
          if (items) setVocabulary(items);
          setSyncState("云端已同步");
        })
        .catch(() => setSyncState("离线使用 · 稍后同步"));
    }
  }, [session?.accessToken, profile?.mustChangePassword, profile?.level, JSON.stringify(profile?.topics ?? [])]);

  const authenticate = ({ session: nextSession, profile: nextProfile }) => {
    setSession(nextSession);
    setProfile(nextProfile);
    setLoginHint(null);
    setSyncState(nextSession.cloud ? "云端已同步" : "本地开发模式");
  };

  const updateProfile = (next) => {
    const value = typeof next === "function" ? next(profile) : next;
    setProfile(value);
    setSyncState("正在同步设置…");
    saveProfile(value, session?.accessToken)
      .then(async (saved) => {
        const merged = { ...value, ...saved, onboarded: true };
        setProfile(merged);
        setSyncState(cloudConfigured ? "云端已同步" : "本地已保存");
        if (session?.accessToken) {
          setFeed(await getDailyFeed(session.accessToken, merged));
        }
      })
      .catch(() => setSyncState("设置待同步"));
  };

  const updateVocabulary = (next) => {
    const previous = vocabulary;
    setVocabulary(next);
    const added = next.filter((item) => !previous.some((old) => old.id === item.id));
    const removed = previous.filter((item) => !next.some((current) => current.id === item.id));
    for (const item of added) {
      saveSyncedVocabulary(item)
        .then((saved) => {
          if (!saved) return;
          setVocabulary((current) => current.map((entry) =>
            entry.id === item.id ? { ...entry, remoteId: saved.id } : entry
          ));
          setSyncState("云端已同步");
        })
        .catch(() => setSyncState("生词待同步"));
    }
    for (const item of removed) {
      deleteSyncedVocabulary(item).catch(() => setSyncState("删除待同步"));
    }
  };

  const reviewVocabulary = (item, rating, after) => {
    setVocabulary((current) => current.map((entry) =>
      entry.id === item.id ? { ...entry, card: after } : entry
    ));
    reviewSyncedVocabulary(item, rating)
      .then(() => setSyncState("复习进度已同步"))
      .catch(() => setSyncState("复习进度待同步"));
  };

  if (!authReady) return <div className="entry-shell auth-loading">正在安全连接苏打阅读…</div>;
  if (!session) {
    return (
      <LoginScreen
        initialUsername={loginHint?.username ?? ""}
        notice={loginHint?.message ?? ""}
        onAuthenticated={authenticate}
      />
    );
  }
  if (profile?.mustChangePassword) {
    return (
      <PasswordChangeScreen
        username={profile.username}
        onChanged={async () => {
          const username = profile.username;
          await logout().catch(() => undefined);
          setSession(null);
          setProfile(null);
          setLoginHint({
            username,
            message: "密码已更新。为了撤销临时密码会话，请用新密码重新登录一次。",
          });
        }}
      />
    );
  }
  if (!profile?.onboarded) {
    return (
      <OnboardingScreen
        onComplete={(next) => {
          updateProfile({ ...next, onboarded: true, username: profile?.username, role: profile?.role });
        }}
      />
    );
  }

  if (activeArticle) {
    return (
      <ReaderScreen
        article={activeArticle}
        theme={theme}
        readingPrefs={readingPrefs}
        onReadingPrefsChange={setReadingPrefs}
        onThemeChange={setTheme}
        onBack={() => setActiveArticle(null)}
        vocabulary={vocabulary}
        onVocabularyChange={updateVocabulary}
        highlights={highlights}
        onHighlightsChange={setHighlights}
        progress={progress[activeArticle.id] ?? 0}
        onProgress={(value) => {
          setProgress((current) => ({ ...current, [activeArticle.id]: value }));
          setResume((current) => current ? { ...current, progress: value } : current);
          saveSyncedProgress({
            contentHash: activeArticle.contentHash ?? activeArticle.id,
            contentId: activeArticle.id,
            chapterId: "body",
            location: { progress: value },
            progress: value,
          }).catch(() => setSyncState("阅读进度待同步"));
        }}
      />
    );
  }

  const openArticle = (article) => {
    const body = articleWithBody(article);
    if (!body?.paragraphs?.length) return;
    setResume({
      ...body,
      progress: progress[body.id] ?? 0,
    });
    setActiveArticle(body);
  };
  const resumeProgress = resume ? progress[resume.id] ?? resume.progress ?? 0 : 0;
  const canResume = Boolean(resume?.id && resumeProgress > 0.02 && resumeProgress < 0.96);
  const shownFeed = displayFeed(feed, profile, fallbackLibrary);
  return (
    <div className={`responsive-app app-shell theme-${theme}`}>
      <DesktopNavigation current={screen} onChange={setScreen} profile={profile} />
      <main className="app-content">
        {screen === "home" && (
          <HomeScreen
            profile={profile}
            feed={shownFeed}
            resume={canResume ? { ...resume, progress: resumeProgress } : null}
            onOpen={openArticle}
            onLevelChange={(level) => updateProfile({ ...profile, level })}
          />
        )}
        {screen === "library" && (
          <LibraryScreen
            documents={documents}
            onDocumentsChange={setDocuments}
            onOpen={openArticle}
          />
        )}
        {screen === "vocabulary" && (
          <VocabularyScreen
            items={vocabulary}
            reviewLimit={profile.reviewLimit ?? 20}
            onChange={updateVocabulary}
            onReview={reviewVocabulary}
          />
        )}
        {screen === "profile" && (
          <ProfileScreen
            profile={profile}
            onProfileChange={updateProfile}
            theme={theme}
            onThemeChange={setTheme}
            readingPrefs={readingPrefs}
            onReadingPrefsChange={setReadingPrefs}
            syncState={syncState}
            onLogout={async () => {
              await logout();
              setSession(null);
              setProfile(null);
            }}
          />
        )}
      </main>
      <DesktopContextPanel
        screen={screen}
        profile={profile}
        feed={shownFeed}
        documents={documents}
        vocabulary={vocabulary}
      />
      <BottomNavigation current={screen} onChange={setScreen} />
    </div>
  );
}

function LoginScreen({ onAuthenticated, initialUsername = "", notice = "" }) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState({ loading: false, error: "" });

  const submit = async (event) => {
    event.preventDefault();
    setStatus({ loading: true, error: "" });
    try {
      onAuthenticated(await loginWithPassword(username, password));
    } catch (error) {
      setStatus({ loading: false, error: error.message });
    }
  };

  return (
    <div className="entry-shell auth-screen">
      <div className="auth-brand">
        <span className="brand-kicker">SODA READING</span>
        <h1>苏打阅读</h1>
        <p>读你真正感兴趣的内容，顺便把英语读得更好。</p>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="username">用户名</label>
        <input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24))}
        />
        <label htmlFor="password">密码</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {notice && <p className="form-notice">{notice}</p>}
        {status.error && <p className="form-error">{status.error}</p>}
        <button className="primary-button" type="submit" disabled={!username || !password || status.loading}>{status.loading ? "正在登录…" : "登录并开始阅读"}</button>
      </form>
      {import.meta.env.DEV && !cloudConfigured && <p className="demo-code">本地预览：admin / Soda-local-2026!</p>}
    </div>
  );
}

function PasswordChangeScreen({ username, onChanged }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState({ loading: false, error: "" });

  const submit = async (event) => {
    event.preventDefault();
    if (password !== confirm) {
      setStatus({ loading: false, error: "两次输入的密码不一致" });
      return;
    }
    setStatus({ loading: true, error: "" });
    try {
      await changePassword(password);
      onChanged();
    } catch (error) {
      setStatus({ loading: false, error: error.message });
    }
  };

  return (
    <div className="entry-shell auth-screen password-change-screen">
      <div className="auth-brand">
        <span className="brand-kicker">FIRST SIGN IN</span>
        <h1>设置自己的密码</h1>
        <p>{username}，临时密码只用于这一次登录。</p>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="new-password">新密码</label>
        <input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 16 位，含大小写、数字和符号" />
        <label htmlFor="confirm-password">再次输入</label>
        <input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="确认新密码" />
        {status.error && <p className="form-error">{status.error}</p>}
        <button className="primary-button" disabled={!password || !confirm || status.loading}>{status.loading ? "正在保存…" : "保存并继续"}</button>
      </form>
    </div>
  );
}

function OnboardingScreen({ onComplete }) {
  const [level, setLevel] = useState("B1");
  const [topics, setTopics] = useState(["科技", "文化"]);
  const [minutes, setMinutes] = useState(10);
  const [reminder, setReminder] = useState("20:30");

  const toggleTopic = (topic) => {
    setTopics((current) => current.includes(topic) ? current.filter((item) => item !== topic) : [...current, topic].slice(-4));
  };

  return (
    <div className="entry-shell onboarding-screen">
      <header className="setup-header"><span>设置</span><strong>阅读水平</strong></header>
      <section className="setup-section">
        <h2>你的英语阅读水平</h2>
        <div className="level-list">
          {levelOptions.map((option) => (
            <button key={option.id} className={level === option.id ? "level-row selected" : "level-row"} onClick={() => setLevel(option.id)}>
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
              {level === option.id && <CheckCircle weight="fill" size={22} />}
            </button>
          ))}
        </div>
      </section>
      <section className="setup-section compact">
        <h2>感兴趣的内容</h2>
        <div className="choice-chips">
          {topicOptions.map((topic) => <button key={topic} className={topics.includes(topic) ? "chip selected" : "chip"} onClick={() => toggleTopic(topic)}>{topic}</button>)}
        </div>
      </section>
      <section className="setup-section setting-grid">
        <label>每日目标<select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="20">20 分钟</option></select></label>
        <label>提醒时间<input type="time" value={reminder} onChange={(event) => setReminder(event.target.value)} /></label>
      </section>
      <button className="primary-button setup-submit" onClick={() => onComplete({ onboarded: true, level, topics, minutes, reminder })}>保存并查看今日文章</button>
    </div>
  );
}

function HomeScreen({ profile, feed, resume, onOpen, onLevelChange }) {
  const primary = feed.primary ?? demoArticle;
  const alternatives = feed.alternatives ?? dailyAlternatives;
  const intro = primary.introZh || primary.summary;
  const featuredProgress = resume?.id === primary.id ? resume.progress : 0;
  return (
    <section className="screen home-screen">
      <header className="screen-header">
        <div><span className="eyebrow">{todayLabel()}</span><h1>今日阅读</h1></div>
        <div className="level-switcher" role="tablist" aria-label="阅读水平">
          {levelOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={profile.level === option.id}
              className={profile.level === option.id ? "selected" : ""}
              onClick={() => onLevelChange(option.id)}
            >
              {option.id}
            </button>
          ))}
        </div>
      </header>
      {resume && resume.id !== primary.id && (
        <button className="resume-strip" type="button" onClick={() => onOpen(resume)}>
          <span>接着读</span>
          <strong>{resume.title}</strong>
          <em>{remainingMinutes(resume, resume.progress)} 分钟</em>
        </button>
      )}
      <article className="featured-reading">
        <div className="article-meta"><span>{primary.topic}</span><span>{primary.cefr} · {remainingMinutes(primary, featuredProgress)} 分钟</span></div>
        <h2>{primary.title}</h2>
        <p className="article-intro">{intro}</p>
        <div className="source-line"><span>{primary.source}</span>{freshnessLabel(primary) && <><span>·</span><time>{freshnessLabel(primary)}</time></>}</div>
        <button className="reading-cta" onClick={() => onOpen(primary)}>
          {featuredProgress > 0.02 ? "继续阅读" : "开始阅读"} <BookOpenText size={20} />
        </button>
      </article>
      <div className="section-heading"><h3>也许你还喜欢</h3></div>
      <div className="article-list">
        {alternatives.map((article) => (
          <button className="article-row" key={article.id} onClick={() => onOpen(article)}>
            <span className="article-topic">{article.topic}</span>
            <span className="article-row-copy">
              <strong>{article.title}</strong>
              {(article.introZh || article.summary) && <em>{article.introZh || article.summary}</em>}
              <small>{[article.source, article.cefr, `${article.readingMinutes} 分钟`, freshnessLabel(article)].filter(Boolean).join(" · ")}</small>
            </span>
            <BookOpenText size={20} />
          </button>
        ))}
      </div>
    </section>
  );
}

function LibraryScreen({ documents, onDocumentsChange, onOpen }) {
  const inputRef = useRef(null);
  const [importState, setImportState] = useState({ loading: false, message: "", error: "" });

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportState({ loading: true, message: `正在检查 ${file.name}`, error: "" });
    try {
      const document = await inspectAndParseFile(file);
      await saveLocalDocument(document);
      const next = await listLocalDocuments();
      onDocumentsChange(next);
      setImportState({ loading: false, message: "已导入", error: "" });
    } catch (error) {
      setImportState({ loading: false, message: "", error: error.message });
    } finally {
      event.target.value = "";
    }
  };

  return (
    <section className="screen library-screen">
      <header className="screen-header"><div><span className="eyebrow">LIBRARY</span><h1>我的书架</h1></div><button className="icon-button strong" onClick={() => inputRef.current?.click()} aria-label="导入文件"><Plus size={22} /></button></header>
      <input ref={inputRef} hidden type="file" accept=".epub,.txt,.pdf" onChange={importFile} />
      <button className="import-panel" onClick={() => inputRef.current?.click()}>
        <FileArrowUp size={28} weight="duotone" />
        <span><strong>{importState.loading ? "正在导入…" : "导入书籍"}</strong><small>EPUB · TXT · PDF</small></span>
      </button>
      {(importState.message || importState.error) && <p className={importState.error ? "inline-status error" : "inline-status"}>{importState.error || importState.message}</p>}
      <div className="section-heading"><h3>本地</h3><span>{documents.length} 项</span></div>
      {documents.length === 0 ? (
        <div className="empty-state"><Books size={42} weight="thin" /><h3>书架还是空的</h3></div>
      ) : (
        <div className="book-list">
          {documents.map((document) => (
            <button className="book-row" key={document.id} onClick={() => onOpen(document)}>
              <span className="book-mark">{document.fileType.toUpperCase()}</span>
              <span><strong>{document.title}</strong><small>{document.author} · {document.readingMinutes} 分钟</small></span>
              <BookOpenText size={20} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function VocabularyScreen({ items, reviewLimit, onChange, onReview }) {
  const [reviewing, setReviewing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const queue = useMemo(() => dueCards(items, reviewLimit), [items, reviewLimit]);
  const current = queue[0];

  const speak = (word) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  };

  const rate = (rating) => {
    if (!current) return;
    const outcome = scheduleReview(current.card, rating);
    onReview(current, rating, outcome.after);
    setRevealed(false);
  };

  if (reviewing && current) {
    return (
      <section className="screen vocabulary-screen review-session">
        <header className="screen-header">
          <div><span className="eyebrow">REVIEW</span><h1>今日复习</h1></div>
          <button className="text-button" onClick={() => setReviewing(false)}>退出</button>
        </header>
        <div className="review-progress-line"><span>本轮还剩 {queue.length} 张</span><span>每日上限 {reviewLimit}</span></div>
        <article className="review-card">
          <button className="pronounce-button" onClick={() => speak(current.word)} aria-label={`朗读 ${current.word}`}><SpeakerHigh size={21} /></button>
          <strong>{current.word}</strong>
          <p>{current.sentence}</p>
          {!revealed ? (
            <button className="primary-button" onClick={() => setRevealed(true)}>显示语境词义</button>
          ) : (
            <>
              <div className="review-answer"><span>{current.phonetic}</span><em>{current.translation}</em></div>
              <div className="review-ratings">
                {REVIEW_RATINGS.map((rating) => (
                  <button key={rating.id} onClick={() => rate(rating.id)} className={`rating-${rating.key}`}>{rating.label}</button>
                ))}
              </div>
            </>
          )}
        </article>
      </section>
    );
  }

  return (
    <section className="screen vocabulary-screen">
      <header className="screen-header"><div><span className="eyebrow">WORDS</span><h1>生词本</h1></div><span className="count-label">{items.length}</span></header>
      {items.length > 0 && (
        <div className="review-entry">
          <div><strong>{queue.length} 张待复习</strong></div>
          <button onClick={() => setReviewing(true)} disabled={!queue.length}>{queue.length ? "开始复习" : "今天已完成"}</button>
        </div>
      )}
      {items.length === 0 ? (
        <div className="empty-state"><BookmarkSimple size={42} weight="thin" /><h3>还没有生词</h3></div>
      ) : (
        <div className="word-list">
          {items.map((item) => (
            <article className="saved-word" key={item.id}>
              <button aria-label={`删除 ${item.word}`} onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}><X size={18} /></button>
              <strong>{item.word}</strong><span>{item.phonetic}</span><em>{item.translation}</em><p>{item.sentence}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ProfileScreen({ profile, onProfileChange, theme, onThemeChange, readingPrefs, onReadingPrefsChange, syncState, onLogout }) {
  const prefs = { ...defaultReadingPrefs, ...readingPrefs };
  return (
    <section className="screen profile-screen">
      <header className="screen-header"><div><span className="eyebrow">YOUR READING</span><h1>阅读设置</h1></div></header>

      <h3 className="settings-label">水平</h3>
      <div className="level-switcher settings-switcher" role="tablist" aria-label="阅读水平">
        {levelOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={profile.level === option.id ? "selected" : ""}
            onClick={() => onProfileChange({ ...profile, level: option.id })}
          >
            {option.id}<small>{option.label}</small>
          </button>
        ))}
      </div>
      <div className="choice-chips profile-topics">
        {topicOptions.map((topic) => (
          <button
            key={topic}
            type="button"
            className={(profile.topics ?? []).includes(topic) ? "chip selected" : "chip"}
            onClick={() => onProfileChange({ ...profile, topics: toggleTopic(profile.topics, topic) })}
          >
            {topic}
          </button>
        ))}
      </div>

      <h3 className="settings-label">纸面</h3>
      <div className="theme-switcher theme-switcher-three" role="group" aria-label="阅读主题">
        {themeOptions.map((option) => (
          <button key={option.id} className={theme === option.id ? "selected" : ""} onClick={() => onThemeChange(option.id)}>
            {option.id === "night" ? <Moon size={18} /> : <Sun size={18} />} {option.label}
          </button>
        ))}
      </div>
      <div className="settings-group">
        <label>
          <span>字体<small>{typefaceOptions.find((item) => item.id === prefs.typeface)?.label}</small></span>
          <select value={prefs.typeface} onChange={(event) => onReadingPrefsChange({ ...prefs, typeface: event.target.value })}>
            {typefaceOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>字号</span>
          <select value={String(prefs.fontScale)} onChange={(event) => onReadingPrefsChange({ ...prefs, fontScale: Number(event.target.value) })}>
            <option value="0.92">小</option>
            <option value="1">中</option>
            <option value="1.12">大</option>
            <option value="1.24">特大</option>
          </select>
        </label>
        <label>
          <span>行距</span>
          <select value={String(prefs.lineHeight)} onChange={(event) => onReadingPrefsChange({ ...prefs, lineHeight: Number(event.target.value) })}>
            {lineHeightOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>栏宽</span>
          <select value={prefs.measure} onChange={(event) => onReadingPrefsChange({ ...prefs, measure: event.target.value })}>
            {measureOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      </div>

      <h3 className="settings-label">节奏</h3>
      <div className="settings-group">
        <label><span>每日目标</span><select value={profile.minutes} onChange={(event) => onProfileChange({ ...profile, minutes: Number(event.target.value) })}><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="20">20 分钟</option></select></label>
        <label><span>每日提醒</span><input type="time" value={profile.reminder} onChange={(event) => onProfileChange({ ...profile, reminder: event.target.value })} /></label>
        <label><span>每日复习</span><select value={profile.reviewLimit ?? 20} onChange={(event) => onProfileChange({ ...profile, reviewLimit: Number(event.target.value) })}>{[10, 20, 30, 40, 50].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label>
      </div>

      <div className="sync-state"><span className={syncState.includes("已") ? "online" : ""} />{syncState}</div>
      {(profile.role === "admin" || profile.username === "admin") && <a className="admin-link" href="/admin">管理台</a>}
      <button className="logout-button" onClick={onLogout}>退出登录</button>
    </section>
  );
}

function DesktopNavigation({ current, onChange, profile }) {
  return (
    <aside className="desktop-navigation">
      <div className="desktop-brand">
        <span>苏打阅读</span>
        <small>SODA READING</small>
      </div>
      <nav aria-label="桌面主导航">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={current === id ? "active" : ""} onClick={() => onChange(id)}>
            <Icon size={21} weight={current === id ? "fill" : "regular"} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="desktop-level">
        <span>{profile.level}</span>
        <div><strong>今日目标</strong><small>{profile.minutes} 分钟阅读</small></div>
      </div>
    </aside>
  );
}

function DesktopContextPanel({ screen, profile, feed, documents, vocabulary }) {
  const primary = feed.primary ?? demoArticle;
  return (
    <aside className="desktop-context-panel">
      {screen === "home" && (
        <>
          <span className="context-kicker">TODAY</span>
          <h2>{primary.title}</h2>
          <p>{primary.introZh || primary.summary}</p>
          <div className="context-stat"><strong>{remainingMinutes(primary)}</strong><span>分钟</span></div>
        </>
      )}
      {screen === "library" && (
        <>
          <span className="context-kicker">LIBRARY</span>
          <h2>书架</h2>
          <div className="context-stat"><strong>{documents.length}</strong><span>项</span></div>
        </>
      )}
      {screen === "vocabulary" && (
        <>
          <span className="context-kicker">WORDS</span>
          <h2>生词</h2>
          <div className="context-stat"><strong>{vocabulary.length}</strong><span>个</span></div>
          {vocabulary.slice(0, 3).map((item) => (
            <div className="context-word" key={item.id}><strong>{item.word}</strong><span>{item.translation}</span></div>
          ))}
        </>
      )}
      {screen === "profile" && (
        <>
          <span className="context-kicker">PROFILE</span>
          <h2>{profile.level} · {levelOptions.find((item) => item.id === profile.level)?.label}</h2>
          <div className="context-stat"><strong>{profile.minutes}</strong><span>分钟</span></div>
        </>
      )}
    </aside>
  );
}

function BottomNavigation({ current, onChange }) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
        <button key={id} className={current === id ? "active" : ""} onClick={() => onChange(id)}><Icon size={23} weight={current === id ? "fill" : "regular"} /><span>{label}</span></button>
      ))}
    </nav>
  );
}

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

function WordGloss({ status, result, onRetry }) {
  if (!status || status === "picking") return null;
  return (
    <rt className={`word-gloss ${status === "error" ? "error" : status}`} role="status" aria-live="polite">
      {status === "loading" && "…"}
      {status === "success" && (
        <>
          <span className="word-contextual">{result?.translation}</span>
          {hasCommonGloss(result) && (
            <>
              <br />
              <span className="word-common">常见 {result.commonTranslation}</span>
            </>
          )}
        </>
      )}
      {status === "error" && <button type="button" onClick={onRetry}>重试</button>}
    </rt>
  );
}

function WordUnit({ surface, item, selected, highlighted, marked, hit, current, status, result, onSelect, onRetry }) {
  const Tag = selected ? "ruby" : "span";
  return (
    <Tag className={`word-unit${selected ? " selected" : ""}${highlighted ? " highlighted" : ""}${marked ? " marked" : ""}${hit ? " hit" : ""}${current ? " hit-current" : ""}${selected && hasCommonGloss(result) ? " has-common" : ""}`}>
      <span
        className="word-surface"
        role="button"
        tabIndex={0}
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
      {selected && <WordGloss status={status} result={result} onRetry={onRetry} />}
    </Tag>
  );
}

function PhraseCluster({ items, status, result, marked, onSelect, onRetry }) {
  return (
    <ruby className={`word-cluster selected${marked ? " marked" : ""}${hasCommonGloss(result) ? " has-common" : ""}`}>
      <span className="word-cluster-words">
        {items.map((item) => (
          item.word ? (
            <span
              key={item.key}
              className="word-surface"
              role="button"
              tabIndex={0}
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
      <WordGloss status={status} result={result} onRetry={onRetry} />
    </ruby>
  );
}

function ReaderScreen({ article, theme, readingPrefs, onReadingPrefsChange, onThemeChange, onBack, vocabulary, onVocabularyChange, highlights, onHighlightsChange, progress, onProgress }) {
  const [selectedWord, setSelectedWord] = useState(null);
  const [selectedSentence, setSelectedSentence] = useState(null);
  const [sentenceResult, setSentenceResult] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const prefs = { ...defaultReadingPrefs, ...readingPrefs };
  const scrollRef = useRef(null);
  const listenRef = useRef(false);
  const restoredProgress = useRef(false);
  const wordRequestRef = useRef(null);
  const sentenceRequestRef = useRef(null);
  const ignoreClickRef = useRef(false);
  const pickRef = useRef(null);

  const paragraphs = article.paragraphs?.length ? article.paragraphs : [];
  const articleHighlights = useMemo(
    () => (highlights ?? []).filter((item) => item.articleId === article.id),
    [highlights, article.id],
  );
  const markedKeys = useMemo(() => {
    const keys = new Set();
    for (const item of articleHighlights) {
      for (const key of item.keys || []) keys.add(key);
    }
    return keys;
  }, [articleHighlights]);
  const findHits = useMemo(() => collectFindHits(paragraphs, findQuery), [paragraphs, findQuery]);
  const hitSet = useMemo(() => new Set(findHits), [findHits]);
  const currentHit = findHits[Math.min(findIndex, Math.max(0, findHits.length - 1))] || "";

  useEffect(() => {
    restoredProgress.current = false;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight) * progress;
      }
      restoredProgress.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [article.id]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      wordRequestRef.current?.abort();
      sentenceRequestRef.current?.abort();
      setSelectedWord(null);
      setSelectedSentence(null);
      setSentenceResult(null);
      setToolsOpen(false);
      setFindOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      wordRequestRef.current?.abort();
      sentenceRequestRef.current?.abort();
      listenRef.current = false;
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    const onFind = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  useEffect(() => {
    setFindIndex(0);
  }, [findQuery, article.id]);

  useEffect(() => {
    if (!findOpen || !findHits.length) return;
    const key = findHits[Math.min(findIndex, findHits.length - 1)];
    const node = scrollRef.current?.querySelector(`[data-word-key="${CSS.escape(key)}"]`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [findOpen, findHits, findIndex]);

  const requestWord = async (context) => {
    wordRequestRef.current?.abort();
    const controller = new AbortController();
    wordRequestRef.current = controller;
    const keys = context.keys ?? (context.key ? [context.key] : []);
    const next = { ...context, keys };
    setSelectedWord({ ...next, status: "loading", result: null, error: "" });
    const query = context.word.trim();
    const normalized = query.includes(" ") ? query.toLowerCase() : normalizeWord(query);
    const prepared = !query.includes(" ") && article.glossary?.find((item) =>
      normalizeWord(item.word ?? item.lemma ?? "") === normalized &&
      (!item.sentence || item.sentence === context.sentence)
    );
    if (prepared?.translation) {
      setSelectedWord({ ...next, status: "success", error: "", result: {
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
          providerLatencyMs: 0,
        },
      });
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
      setSelectedWord({ ...next, status: "success", result, error: "" });
    } catch (error) {
      if (error?.name === "AbortError" || wordRequestRef.current !== controller) return;
      setSelectedWord({
        ...next,
        status: "error",
        result: null,
        error: "暂时无法翻译，请稍后重试。",
      });
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
    const id = `${article.id}:${normalizeWord(selectedWord.word)}`;
    if (vocabulary.some((entry) => entry.id === id)) return;
    onVocabularyChange([...vocabulary, {
      id,
      contentHash: article.contentHash ?? article.id,
      contentId: article.id,
      word: selectedWord.word,
      sentence: selectedWord.sentence,
      before: selectedWord.before,
      after: selectedWord.after,
      ...selectedWord.result,
    }]);
  };

  const selectedHighlightId = selectedWord?.keys?.length ? highlightId(article.id, selectedWord.keys) : "";
  const selectedIsMarked = articleHighlights.some((item) => item.id === selectedHighlightId);
  const articleWords = vocabulary.filter((item) => (item.contentId ?? item.contentHash) === article.id || (item.contentId ?? item.contentHash) === (article.contentHash ?? article.id));
  const needle = findQuery.trim();
  const leftMinutes = remainingMinutes(article, progress);

  const toggleHighlight = () => {
    if (!selectedWord?.keys?.length) return;
    const id = highlightId(article.id, selectedWord.keys);
    if (selectedIsMarked) {
      onHighlightsChange((highlights ?? []).filter((item) => item.id !== id));
      return;
    }
    onHighlightsChange([...(highlights ?? []), {
      id,
      articleId: article.id,
      word: selectedWord.word,
      keys: selectedWord.keys,
      sentence: selectedWord.sentence,
    }]);
  };

  const copySentence = async (text) => {
    const value = text || selectedWord?.sentence || "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* clipboard may be blocked */
    }
  };

  const jumpToKey = (key) => {
    if (!key) return;
    const node = scrollRef.current?.querySelector(`[data-word-key="${CSS.escape(key)}"]`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const stopListening = () => {
    listenRef.current = false;
    window.speechSynthesis?.cancel();
    setListening(false);
  };

  const toggleListening = () => {
    if (!("speechSynthesis" in window)) return;
    if (listening) {
      stopListening();
      return;
    }
    window.speechSynthesis.cancel();
    listenRef.current = true;
    setListening(true);
    const queue = [...paragraphs];
    const next = () => {
      if (!listenRef.current || queue.length === 0) {
        setListening(false);
        listenRef.current = false;
        return;
      }
      const utterance = new SpeechSynthesisUtterance(queue.shift());
      utterance.lang = "en-US";
      utterance.rate = 0.92;
      utterance.onend = next;
      utterance.onerror = stopListening;
      window.speechSynthesis.speak(utterance);
    };
    next();
  };

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
        <div className="reader-chapter">
          <span>还剩</span>
          <strong>{leftMinutes} 分钟</strong>
        </div>
        <div className="reader-side-progress">
          <span><strong>{Math.round(progress * 100)}%</strong></span>
          <div><i style={{ width: `${progress * 100}%` }} /></div>
        </div>
      </aside>
      <section className="reader-main">
        <header className="reader-header">
          <button className="reader-icon mobile-reader-back" onClick={onBack} aria-label="返回"><ArrowLeft size={24} /></button>
          <span className="reader-brand">苏打阅读</span>
          <div className="reader-progress" aria-label={`还剩 ${leftMinutes} 分钟`}><span>{leftMinutes} 分钟</span><div><i style={{ width: `${progress * 100}%` }} /></div></div>
          <button className={`reader-icon${listening ? " listening" : ""}`} onClick={toggleListening} aria-label={listening ? "停止朗读" : "朗读全文"}>{listening ? <Pause size={22} /> : <SpeakerHigh size={22} />}</button>
          <button className={`reader-icon${findOpen ? " listening" : ""}`} onClick={() => setFindOpen((value) => !value)} aria-label="查找"><MagnifyingGlass size={22} /></button>
          <button className="reader-icon" onClick={() => onThemeChange(theme === "night" ? "day" : theme === "sepia" ? "night" : "sepia")} aria-label="切换纸色">{theme === "night" ? <Moon size={22} /> : <Sun size={22} />}</button>
          <button className="reader-icon" onClick={() => setToolsOpen((value) => !value)} aria-label="阅读设置"><TextAa size={23} /></button>
        </header>
        {findOpen && (
          <div className="reader-find">
            <MagnifyingGlass size={16} />
            <input
              className="find-input"
              value={findQuery}
              onChange={(event) => setFindQuery(event.target.value)}
              placeholder="查找"
              aria-label="在文章中查找"
              autoFocus
            />
            <span>{needle ? `${findHits.length ? Math.min(findIndex, findHits.length - 1) + 1 : 0}/${findHits.length}` : ""}</span>
            <button type="button" disabled={!findHits.length} onClick={() => setFindIndex((value) => (value - 1 + findHits.length) % findHits.length)} aria-label="上一处"><CaretLeft size={16} /></button>
            <button type="button" disabled={!findHits.length} onClick={() => setFindIndex((value) => (value + 1) % findHits.length)} aria-label="下一处"><CaretRight size={16} /></button>
            <button type="button" onClick={() => { setFindOpen(false); setFindQuery(""); }} aria-label="关闭查找"><X size={16} /></button>
          </div>
        )}
        {toolsOpen && (
          <div className={`reader-tools${findOpen ? " with-find" : ""}`}>
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
              <button type="button" onClick={toggleHighlight} disabled={!selectedWord?.keys?.length} className={selectedIsMarked ? "selected" : ""}>
                <Highlighter size={16} />划线
              </button>
              <button type="button" onClick={() => copySentence()} disabled={!selectedWord?.sentence}><Copy size={16} />复制</button>
              <button type="button" onClick={saveSelectedWord} disabled={!selectedWord?.result}><BookmarkSimple size={16} />收藏</button>
            </div>
          </div>
        )}
        <article
          ref={scrollRef}
          className={`reader-scroll${toolsOpen ? " tools-open" : ""}${findOpen ? " find-open" : ""}`}
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
            if (!event.target.closest("[data-word-key], .sentence-dot, .sentence-translation, a")) {
              wordRequestRef.current?.abort();
              setSelectedWord(null);
            }
          }}
          onScroll={(event) => {
            if (!restoredProgress.current) return;
            const element = event.currentTarget;
            const ratio = element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
            if (Math.abs(ratio - progress) > 0.05) onProgress(Math.min(1, Math.max(0, ratio)));
          }}
        >
          <div className="reader-title-block"><span>{article.topic ?? "本地内容"} · {article.cefr}</span><h1>{article.title}</h1></div>
          {paragraphs.map((paragraph, paragraphIndex) => {
            const sentences = splitSentences(paragraph);
            const previousSentences = paragraphIndex > 0 ? splitSentences(paragraphs[paragraphIndex - 1]) : [];
            const nextSentences = paragraphIndex < paragraphs.length - 1 ? splitSentences(paragraphs[paragraphIndex + 1]) : [];
            return (
              <p className="reader-paragraph" key={`${article.id}-${paragraphIndex}`}>
                {sentences.map((sentence, sentenceIndex) => {
                  const sentenceKey = `${paragraphIndex}-${sentenceIndex}`;
                  const { body: sentenceBody, ending: sentenceEnding } = splitSentenceEnding(sentence);
                  const before = sentences[sentenceIndex - 1] ?? previousSentences.at(-1) ?? "";
                  const after = sentences[sentenceIndex + 1] ?? nextSentences[0] ?? "";
                  return (
                    <span
                      className="sentence-unit"
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
                                  onSelect={() => handleWord(context)}
                                  onRetry={() => requestWord(selectedWord)}
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
                                hit={hitSet.has(item.key)}
                                current={item.key === currentHit}
                                status={single ? selectedWord.status : ""}
                                result={single ? selectedWord.result : null}
                                onSelect={() => handleWord(context)}
                                onRetry={() => requestWord(context)}
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
            <em>{selectedWord.result.referent ? "文中指代" : "语境义"} {selectedWord.result.translation}</em>
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
              <button type="button" onClick={() => copySentence()}><Copy size={18} />复制</button>
              <button onClick={saveSelectedWord} disabled={vocabulary.some((entry) => entry.id === `${article.id}:${normalizeWord(selectedWord.word)}`)}>
                <BookmarkSimple size={18} />{vocabulary.some((entry) => entry.id === `${article.id}:${normalizeWord(selectedWord.word)}`) ? "已收藏" : "收藏"}
              </button>
            </div>
          </div>
        )}
        {!selectedWord && (
          <>
            <div className="study-recent">
              <span>划线</span>
              {articleHighlights.map((item) => (
                <button type="button" className="study-jump" key={item.id} onClick={() => jumpToKey(item.keys?.[0])}>
                  <strong>{item.word}</strong>
                  <span>{item.sentence}</span>
                </button>
              ))}
            </div>
            <div className="study-recent">
              <span>生词</span>
              {articleWords.map((item) => (
                <div key={item.id}><strong>{item.word}</strong><span>{item.translation}</span></div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
