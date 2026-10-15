export {
  demoArticle,
  urbanTreesArticle,
  oceanHeatArticle,
  libraryQuietArticle,
  dailyAlternatives,
  fallbackLibrary,
} from "@soda-reading/core";

export const topicOptions = ["科技", "文化", "商业", "自然", "健康", "历史"];

export const levelOptions = [
  { id: "A2", label: "初级", description: "短句、日常词，适合刚开始读完整短文" },
  { id: "B1", label: "中级", description: "能读常见故事与清楚的观点" },
  { id: "B2", label: "中高级", description: "能读稍长的解释与专业话题" },
  { id: "C1", label: "高级", description: "复杂长句与抽象观点" },
];

export const typefaceOptions = [
  { id: "newsreader", label: "杂志衬线", sample: "The quiet page" },
  { id: "georgia", label: "书页衬线", sample: "A slower sentence" },
  { id: "inter", label: "无衬线", sample: "Clearer on screens" },
];

export const lineHeightOptions = [
  { id: 1.65, label: "紧" },
  { id: 1.85, label: "适" },
  { id: 2.1, label: "疏" },
];

export const measureOptions = [
  { id: "compact", label: "窄", width: "32em" },
  { id: "comfortable", label: "中", width: "38em" },
  { id: "generous", label: "宽", width: "46em" },
];

export const themeOptions = [
  { id: "day", label: "日间" },
  { id: "sepia", label: "书页" },
  { id: "night", label: "夜间" },
];

export const listenRateOptions = [
  { id: 0.85, label: "慢" },
  { id: 1, label: "常" },
  { id: 1.15, label: "快" },
];

export const defaultReadingPrefs = {
  typeface: "newsreader",
  fontScale: 1,
  lineHeight: 1.85,
  measure: "comfortable",
  listenRate: 1,
};

export const contextualDictionary = {
  seeking: { lemma: "seek", phonetic: "/siːk/", partOfSpeech: "v.", translation: "寻求", commonTranslation: "寻找" },
  curiosity: { lemma: "curiosity", phonetic: "/ˌkjʊəriˈɒsəti/", partOfSpeech: "n.", translation: "好奇心", commonTranslation: "好奇心" },
  infrastructure: { lemma: "infrastructure", phonetic: "/ˈɪnfrəstrʌktʃə/", partOfSpeech: "n.", translation: "基础结构", commonTranslation: "基础设施" },
  vibrant: { lemma: "vibrant", phonetic: "/ˈvaɪbrənt/", partOfSpeech: "adj.", translation: "充满活力的", commonTranslation: "鲜艳的" },
  thoughtful: { lemma: "thoughtful", phonetic: "/ˈθɔːtfl/", partOfSpeech: "adj.", translation: "善于思考的", commonTranslation: "体贴的" },
};

export const sourcePolicies = [
  { id: "soda-editorial", name: "苏打阅读原创导读", license: "原创", crawl: false, fullText: true, commercial: true, status: "active" },
  { id: "nasa", name: "NASA News", license: "政府公开内容/逐项核验", crawl: true, fullText: false, commercial: false, status: "review" },
  { id: "noaa", name: "NOAA Ocean Service", license: "政府公开内容/逐项核验", crawl: true, fullText: false, commercial: false, status: "active" },
  { id: "arxiv", name: "arXiv API", license: "仅元数据与摘要索引", crawl: true, fullText: false, commercial: false, status: "active" },
];
