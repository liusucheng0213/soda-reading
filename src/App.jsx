import { useEffect, useRef, useState } from "react";
import {
  BookOpenText,
  Books,
  BookmarkSimple,
  CheckCircle,
  FileArrowUp,
  House,
  Moon,
  Plus,
  Sun,
  UserCircle,
} from "@phosphor-icons/react";
import {
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
import { getDailyFeed, saveProfile } from "./lib/api.js";
import { DEFAULT_LOCAL_PROFILE, normalizeProfile } from "./lib/profile.js";
import { dueCards } from "@soda-reading/core";
import { inspectAndParseFile } from "./lib/importers.js";
import { deleteLocalDocument, listLocalDocuments, migrateLocalAccount, persistState, replaceLocalDocuments, resolveAccountBase, saveLocalDocument, useStoredState, writeAccountState } from "./lib/storage.js";
import { AdminApp } from "./AdminApp.jsx";
import { DataManagement } from "./screens/DataManagement.jsx";
import { PlacementScreen } from "./screens/PlacementScreen.jsx";
import { ReaderScreen } from "./screens/ReaderScreen.jsx";
import { VocabularyScreen } from "./screens/VocabularyScreen.jsx";
import { articleWithBody, displayFeed } from "./lib/feed.js";
import {
  applyReadingProgress,
  freshnessLabel,
  glossText,
  isCurrentSave,
  remainingMinutes,
  resumeFromProgress,
  todayReadMinutes,
  uniqueArticles,
} from "./lib/study.js";

const NAV_ITEMS = [
  { id: "home", label: "今日", icon: House },
  { id: "library", label: "书架", icon: Books },
  { id: "vocabulary", label: "生词", icon: BookmarkSimple },
  { id: "profile", label: "我的", icon: UserCircle },
];

const EMPTY_LIST = [];
const EMPTY_PROGRESS = {};

function useAccountState(username, bucket, fallback) {
  const owner = username || "";
  const [packet, setPacket] = useState(() => ({
    owner,
    value: resolveAccountBase(null, owner, bucket, fallback),
  }));
  if (packet.owner !== owner) {
    setPacket({ owner, value: resolveAccountBase(packet, owner, bucket, fallback) });
  }
  const value = resolveAccountBase(packet, owner, bucket, fallback);

  const update = (next) => {
    setPacket((current) => {
      const base = resolveAccountBase(current, owner, bucket, fallback);
      const resolved = typeof next === "function" ? next(base) : next;
      if (owner) writeAccountState(owner, bucket, resolved);
      return { owner, value: resolved };
    });
  };

  return [value, update];
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
  const [profile, setProfile] = usePersistentState("soda.profile", DEFAULT_LOCAL_PROFILE);
  const [accountName] = useState(() => migrateLocalAccount(profile));
  const [syncState, setSyncState] = useState("本地个人模式");
  const [theme, setTheme] = usePersistentState("soda.theme", "day");
  const [readingPrefs, setReadingPrefs] = usePersistentState("soda.readingPrefs", defaultReadingPrefs);
  const [resume, setResume] = useAccountState(accountName, "resume", null);
  const [screen, setScreen] = useState("home");
  const [activeArticle, setActiveArticle] = useState(null);
  const [placementOpen, setPlacementOpen] = useState(false);
  const [placement, setPlacement] = useAccountState(accountName, "placement", null);
  const [feed, setFeed] = useState({ primary: demoArticle, alternatives: dailyAlternatives, fallback: true });
  const [documents, setDocuments] = useState([]);
  const [vocabulary, setVocabulary] = useAccountState(accountName, "vocabulary", EMPTY_LIST);
  const [highlights, setHighlights] = useAccountState(accountName, "highlights", EMPTY_LIST);
  const [progress, setProgress] = useAccountState(accountName, "progress", EMPTY_PROGRESS);
  const [positions, setPositions] = useAccountState(accountName, "positions", EMPTY_PROGRESS);
  const [articleFeedback, setArticleFeedback] = useAccountState(accountName, "articleFeedback", EMPTY_PROGRESS);
  const [readingDay, setReadingDay] = useAccountState(accountName, "readingDay", null);
  const [readerFocus, setReaderFocus] = useState(null);
  const [vocabReviewing, setVocabReviewing] = useState(false);
  const [reviewFilterId, setReviewFilterId] = useState(null);
  const [closedArticleId, setClosedArticleId] = useState("");
  const profileSaveRef = useRef(0);

  useEffect(() => {
    setProfile((current) => normalizeProfile(current));
    listLocalDocuments().then(setDocuments).catch(() => setDocuments([]));
  }, []);

  useEffect(() => {
    const shown = displayFeed(feed, profile, fallbackLibrary);
    const catalog = uniqueArticles([
      shown.primary,
      ...(shown.alternatives ?? []),
      ...fallbackLibrary,
      ...documents,
    ]);
    const next = resumeFromProgress(catalog, progress, resume);
    if (!next?.id || next.id === resume?.id) return;
    setResume(next);
  }, [feed, profile, documents, progress, resume]);

  useEffect(() => {
    let active = true;
    getDailyFeed(normalizeProfile(profile)).then((next) => {
      if (active) setFeed(next);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const updateProfile = (next) => {
    const value = normalizeProfile(typeof next === "function" ? next(profile) : next);
    const generation = profileSaveRef.current + 1;
    profileSaveRef.current = generation;
    setProfile(value);
    setSyncState("正在保存设置…");
    saveProfile(value)
      .then(async (saved) => {
        if (!isCurrentSave(generation, profileSaveRef.current)) return;
        const merged = normalizeProfile({ ...value, ...saved, onboarded: true });
        setProfile(merged);
        setSyncState("本地已保存");
        const nextFeed = await getDailyFeed(merged);
        if (!isCurrentSave(generation, profileSaveRef.current)) return;
        setFeed(nextFeed);
      })
      .catch(() => {
        if (isCurrentSave(generation, profileSaveRef.current)) setSyncState("设置未保存");
      });
  };

  const updateVocabulary = (next) => {
    setVocabulary(next);
  };

  const reviewVocabulary = (item, _rating, afterItem) => {
    setVocabulary((current) => current.map((entry) =>
      entry.id === item.id ? afterItem : entry
    ));
  };

  const removeDocument = async (id) => {
    await deleteLocalDocument(id);
    setDocuments((current) => current.filter((document) => document.id !== id));
    setHighlights((current) => current.filter((item) => item.articleId !== id));
    setProgress((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    setPositions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    setResume((current) => current?.id === id ? null : current);
  };

  const clearData = async (bucket) => {
    if (bucket === "vocabulary") setVocabulary([]);
    if (bucket === "highlights") setHighlights([]);
    if (bucket === "documents") {
      const ids = new Set(documents.map((document) => document.id));
      await replaceLocalDocuments([]);
      setDocuments([]);
      setHighlights((current) => current.filter((item) => !ids.has(item.articleId)));
      setProgress((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !ids.has(key))));
      setPositions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !ids.has(key))));
      setResume((current) => ids.has(current?.id) ? null : current);
    }
  };

  if (placementOpen) {
    return (
      <PlacementScreen
        onCancel={() => setPlacementOpen(false)}
        onComplete={(result) => {
          setPlacement({ ...result, completedAt: new Date().toISOString() });
          updateProfile({ ...profile, level: result.level, onboarded: true });
          setPlacementOpen(false);
        }}
      />
    );
  }

  if (!profile?.onboarded) {
    return (
      <OnboardingScreen
        onComplete={(next) => updateProfile({ ...next, onboarded: true })}
        onStart={() => setPlacementOpen(true)}
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
        onBack={() => {
          setActiveArticle(null);
          setReaderFocus(null);
        }}
        vocabulary={vocabulary}
        onVocabularyChange={updateVocabulary}
        highlights={highlights}
        onHighlightsChange={setHighlights}
        progress={progress[activeArticle.id] ?? 0}
        position={positions[activeArticle.id]}
        focus={readerFocus}
        onFocusConsumed={() => setReaderFocus(null)}
        feedback={articleFeedback[activeArticle.id]?.feeling}
        onFeedback={(feeling) => setArticleFeedback((current) => ({
          ...current,
          [activeArticle.id]: { feeling, updatedAt: new Date().toISOString() },
        }))}
        onReview={(articleId) => {
          setReviewFilterId(articleId);
          setActiveArticle(null);
          setScreen("vocabulary");
          setVocabReviewing(true);
        }}
        onAdjustLevel={(level) => updateProfile({ ...profile, level })}
        onProgress={(value, location) => {
          const previous = progress[activeArticle.id] ?? 0;
          setProgress((current) => ({ ...current, [activeArticle.id]: value }));
          if (location) {
            setPositions((current) => ({
              ...current,
              [activeArticle.id]: { ...location, progress: value, updatedAt: new Date().toISOString() },
            }));
          }
          setReadingDay((log) => applyReadingProgress(log, activeArticle, previous, value));
          setResume((current) => current ? { ...current, progress: value } : current);
        }}
      />
    );
  }

  const readMinutes = todayReadMinutes(readingDay);
  const openArticle = (article, focus) => {
    const body = articleWithBody(article, fallbackLibrary);
    if (!body?.paragraphs?.length) {
      setClosedArticleId(article?.id || "");
      return;
    }
    setClosedArticleId("");
    setResume({
      ...body,
      progress: progress[body.id] ?? 0,
    });
    setReaderFocus(focus ?? null);
    setActiveArticle(body);
  };
  const resumeProgress = resume ? progress[resume.id] ?? resume.progress ?? 0 : 0;
  const canResume = Boolean(resume?.id && resumeProgress > 0.02 && resumeProgress < 0.96);
  const shownFeed = displayFeed(feed, profile, fallbackLibrary);
  const catalog = uniqueArticles([
    shownFeed.primary,
    ...(shownFeed.alternatives ?? []),
    ...fallbackLibrary,
    ...documents,
  ]);
  const dueReviewCount = dueCards(vocabulary, profile.reviewLimit ?? 20).length;
  return (
    <div className={`responsive-app app-shell theme-${theme}`}>
      <DesktopNavigation current={screen} onChange={setScreen} profile={profile} readMinutes={readMinutes} />
      <main className="app-content">
        {screen === "home" && (
          <HomeScreen
            profile={profile}
            feed={shownFeed}
            resume={canResume ? { ...resume, progress: resumeProgress } : null}
            onOpen={openArticle}
            onLevelChange={(level) => updateProfile({ ...profile, level })}
            closedArticleId={closedArticleId}
            reviewCount={dueReviewCount}
            onReview={() => {
              setReviewFilterId(null);
              setScreen("vocabulary");
              setVocabReviewing(true);
            }}
          />
        )}
        {screen === "library" && (
          <LibraryScreen
            documents={documents}
            catalog={uniqueArticles([shownFeed.primary, ...(shownFeed.alternatives ?? []), ...fallbackLibrary])}
            progress={progress}
            onDocumentsChange={setDocuments}
            onOpen={openArticle}
            closedArticleId={closedArticleId}
          />
        )}
        {screen === "vocabulary" && (
          <VocabularyScreen
            items={vocabulary}
            catalog={catalog}
            reviewLimit={profile.reviewLimit ?? 20}
            onChange={updateVocabulary}
            onReview={reviewVocabulary}
            onOpen={openArticle}
            reviewing={vocabReviewing}
            onReviewingChange={setVocabReviewing}
            sessionItems={reviewFilterId ? vocabulary.filter((item) => (item.contentId ?? item.contentHash) === reviewFilterId) : vocabulary}
            reviewFilterId={reviewFilterId}
            onClearReviewFilter={() => setReviewFilterId(null)}
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
            readMinutes={readMinutes}
            documents={documents}
            vocabularyCount={vocabulary.length}
            highlightCount={highlights.length}
            onDeleteDocument={removeDocument}
            onClearData={clearData}
            placement={placement}
            onStartPlacement={() => setPlacementOpen(true)}
          />
        )}
      </main>
      <DesktopContextPanel
        screen={screen}
        profile={profile}
        feed={shownFeed}
        documents={documents}
        vocabulary={vocabulary}
        readMinutes={readMinutes}
      />
      <BottomNavigation current={screen} onChange={setScreen} />
    </div>
  );
}

function OnboardingScreen({ onComplete, onStart }) {
  const [level, setLevel] = useState("B1");
  const [topics, setTopics] = useState(["科技", "文化"]);
  const [minutes, setMinutes] = useState(10);

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
      </section>
      <button className="primary-button setup-submit" onClick={() => onComplete({ onboarded: true, level, topics, minutes })}>保存并查看今日文章</button>
      <button className="text-button setup-submit" onClick={onStart}>先测一测我的水平</button>
      <button className="text-button setup-submit" onClick={() => onComplete({ ...DEFAULT_LOCAL_PROFILE, onboarded: true })}>先按默认设置使用</button>
    </div>
  );
}

function HomeScreen({ profile, feed, resume, onOpen, onLevelChange, closedArticleId, reviewCount = 0, onReview }) {
  const primary = feed.primary ?? demoArticle;
  const alternatives = feed.alternatives ?? [];
  const intro = primary.introZh || primary.summary;
  const featuredProgress = resume?.id === primary.id ? resume.progress : 0;
  return (
    <section className="screen home-screen">
      <header className="screen-header">
        <div><span className="eyebrow">{todayLabel()}</span><h1>{feed.standby ? "备用导读" : "今日阅读"}</h1></div>
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
      {reviewCount > 0 && <button type="button" className="review-today-link" onClick={onReview}>{reviewCount} 张生词待复习 <span>开始复习</span></button>}
      <article className="featured-reading">
        <div className="article-meta"><span>{primary.topic}</span><span>{primary.cefr} · {remainingMinutes(primary, featuredProgress)} 分钟</span></div>
        <h2>{primary.title}</h2>
        <p className="article-intro">{intro}</p>
        <div className="source-line"><span>{primary.source}</span>{freshnessLabel(primary) && <><span>·</span><time>{freshnessLabel(primary)}</time></>}</div>
        <button className="reading-cta" onClick={() => onOpen(primary)}>
          {featuredProgress > 0.02 ? "继续阅读" : "开始阅读"} <BookOpenText size={20} />
        </button>
        {closedArticleId === primary.id && <p className="inline-status error">这篇还没有正文，暂时打不开。</p>}
      </article>
      {alternatives.length > 0 && (
        <>
          <div className="section-heading"><h3>也许你还喜欢</h3></div>
          <div className="article-list">
            {alternatives.map((article) => (
              <div key={article.id}>
                <button className="article-row" onClick={() => onOpen(article)}>
                  <span className="article-topic">{article.topic}</span>
                  <span className="article-row-copy">
                    <strong>{article.title}</strong>
                    {(article.introZh || article.summary) && <em>{article.introZh || article.summary}</em>}
                    <small>{[article.source, article.cefr, `${article.readingMinutes} 分钟`, freshnessLabel(article)].filter(Boolean).join(" · ")}</small>
                  </span>
                  <BookOpenText size={20} />
                </button>
                {closedArticleId === article.id && <p className="inline-status error">这篇还没有正文，暂时打不开。</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function LibraryScreen({ documents, catalog = [], progress = {}, onDocumentsChange, onOpen, closedArticleId }) {
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
      {catalog.length > 0 && (
        <>
          <div className="section-heading"><h3>馆藏</h3><span>{catalog.length} 篇</span></div>
          <div className="article-list">
            {catalog.map((article) => (
              <div key={article.id}>
                <button className="article-row" onClick={() => onOpen(article)}>
                  <span className="article-topic">{article.topic ?? "本地"}</span>
                  <span className="article-row-copy">
                    <strong>{article.title}</strong>
                    {(article.introZh || article.summary) && <em>{article.introZh || article.summary}</em>}
                    <small>{[article.source, article.cefr, `${remainingMinutes(article, progress[article.id] ?? 0)} 分钟`].filter(Boolean).join(" · ")}</small>
                  </span>
                  <BookOpenText size={20} />
                </button>
                {closedArticleId === article.id && <p className="inline-status error">这篇还没有正文，暂时打不开。</p>}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="section-heading"><h3>本地</h3><span>{documents.length} 项</span></div>
      {documents.length === 0 ? (
        <div className="empty-state compact"><Books size={36} weight="thin" /><h3>还没有导入的书</h3></div>
      ) : (
        <div className="book-list">
          {documents.map((document) => (
            <div key={document.id}>
              <button className="book-row" onClick={() => onOpen(document)}>
                <span className="book-mark">{document.fileType.toUpperCase()}</span>
                <span><strong>{document.title}</strong><small>{document.author} · {remainingMinutes(document, progress[document.id] ?? 0)} 分钟</small></span>
                <BookOpenText size={20} />
              </button>
              {closedArticleId === document.id && <p className="inline-status error">这篇还没有正文，暂时打不开。</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ProfileScreen({ profile, onProfileChange, theme, onThemeChange, readingPrefs, onReadingPrefsChange, syncState, readMinutes = 0, documents, vocabularyCount, highlightCount, onDeleteDocument, onClearData, placement, onStartPlacement }) {
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
      <div className="placement-settings">
        <button type="button" className="text-button" onClick={onStartPlacement}>{placement ? "重新测试水平" : "测一测我的水平"}</button>
        {placement?.level && <small>上次估计 {placement.level}，仅供参考</small>}
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
      <p className="today-read">今天已读 {readMinutes} / {profile.minutes || 10} 分钟</p>
      <div className="settings-group">
        <label><span>每日目标</span><select value={profile.minutes} onChange={(event) => onProfileChange({ ...profile, minutes: Number(event.target.value) })}><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="20">20 分钟</option></select></label>
        <label><span>每日复习</span><select value={profile.reviewLimit ?? 20} onChange={(event) => onProfileChange({ ...profile, reviewLimit: Number(event.target.value) })}>{[10, 20, 30, 40, 50].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label>
      </div>

      <div className="sync-state"><span className={syncState.includes("已") ? "online" : ""} />{syncState}</div>
      <p className="today-read">无需账号。生词、进度和导入书籍仅保存在此浏览器。</p>
      <DataManagement
        documents={documents}
        vocabularyCount={vocabularyCount}
        highlightCount={highlightCount}
        onDeleteDocument={onDeleteDocument}
        onClearData={onClearData}
      />
    </section>
  );
}

function DesktopNavigation({ current, onChange, profile, readMinutes = 0 }) {
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
        <div><strong>今天已读</strong><small>{readMinutes} / {profile.minutes || 10} 分钟</small></div>
      </div>
    </aside>
  );
}

function DesktopContextPanel({ screen, profile, feed, documents, vocabulary, readMinutes = 0 }) {
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
            <div className="context-word" key={item.id}><strong>{item.word}</strong><span>{glossText(item)}</span></div>
          ))}
        </>
      )}
      {screen === "profile" && (
        <>
          <span className="context-kicker">PROFILE</span>
          <h2>{profile.level} · {levelOptions.find((item) => item.id === profile.level)?.label}</h2>
          <div className="context-stat"><strong>{readMinutes}</strong><span>/ {profile.minutes || 10} 分钟</span></div>
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

