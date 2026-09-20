import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceRoleKey) {
  throw new Error("Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY");
}
const service = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const suffix = Date.now().toString(36);
const ids = {
  source: `edge-source-${suffix}`,
  candidate: `edge-candidate-${suffix}`,
  cluster: `edge-cluster-${suffix}`,
  articles: [`edge-article-a-${suffix}`, `edge-article-b-${suffix}`, `edge-article-c-${suffix}`],
  authUsers: [],
};

async function createAuthUser(username, role) {
  const { data, error } = await service.auth.admin.createUser({
    email: `${username}@users.soda.invalid`,
    password: "Edge-Test-Aa1!23456789",
    email_confirm: true,
    app_metadata: { role, session_version: 1 },
    user_metadata: { username, cefr: "B1", topics: ["科技", "文化"], must_change_password: false },
  });
  assert.ifError(error);
  ids.authUsers.push(data.user.id);
  const { error: updateError } = await service.from("profiles").update({
    role,
    cefr: "B1",
    topics: ["科技", "文化"],
    must_change_password: false,
  }).eq("id", data.user.id);
  assert.ifError(updateError);
  return data.user;
}

async function signIn(username, password = "Edge-Test-Aa1!23456789") {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: `${username}@users.soda.invalid`,
    password,
  });
  assert.ifError(error);
  return { client, token: data.session.access_token, user: data.user };
}

async function call(name, token, { method = "POST", body } = {}) {
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

try {
  const adminName = `admin_${suffix}`;
  const readerName = `reader_${suffix}`;
  const adminUser = await createAuthUser(adminName, "admin");
  await createAuthUser(readerName, "reader");
  const adminAuth = await signIn(adminName);
  const readerAuth = await signIn(readerName);

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const publishedAt = new Date().toISOString();
  assert.ifError((await service.from("source_policies").insert({
    id: ids.source,
    name: "Edge integration source",
    license: "test-only",
    crawl_allowed: false,
    full_text_allowed: false,
    status: "active",
    source_tier: "A",
  })).error);
  assert.ifError((await service.from("content_candidates").insert({
    id: ids.candidate,
    source_id: ids.source,
    external_id: ids.candidate,
    canonical_url: "https://example.test/evidence",
    title: "A reliable integration test article",
    summary: "This test metadata provides enough English evidence for an isolated local check.",
    authors: ["Test"],
    source_published_at: publishedAt,
    topic: "科技",
    raw_hash: createHash("sha256").update(ids.candidate).digest("hex"),
    title_fingerprint: createHash("sha256").update("title").digest("hex"),
    quality_score: 90,
    status: "accepted",
  })).error);
  assert.ifError((await service.from("story_clusters").insert({
    id: ids.cluster,
    topic: "科技",
    canonical_title: "Edge integration",
    candidate_ids: [ids.candidate],
    independent_source_ids: [ids.source],
    evidence_score: 90,
    risk_level: "low",
    status: "ready",
  })).error);
  const baseSentence = "Readers can verify this sentence without waiting for a model.";
  const articleRows = ids.articles.map((id, index) => ({
    id,
    story_cluster_id: ids.cluster,
    source_candidate_id: ids.candidate,
    title: `Prepared article ${index + 1}`,
    summary: "验证预生成翻译与每日推荐。",
    paragraphs: [baseSentence, "The article has a complete and calm conclusion."],
    sentence_translations: {
      [baseSentence]: "读者无需等待模型即可验证这个句子。",
      "The article has a complete and calm conclusion.": "这篇文章有一个完整而平静的结尾。",
    },
    glossary: [{
      word: "verify",
      lemma: "verify",
      partOfSpeech: "verb",
      phonetic: "/ˈverɪfaɪ/",
      translation: "核验",
      sentence: baseSentence,
    }],
    body_hash: createHash("sha256").update(id).digest("hex"),
    cefr: "B1",
    word_count: 380,
    reading_minutes: 3,
    topic: index === 1 ? "文化" : "科技",
    content_mode: "editorial_digest",
    quality_score: 90,
    source_published_at: publishedAt,
    sources: [{ label: "test", url: "https://example.test/evidence", publishedAt }],
    risk_flags: [],
    review_status: "approved",
    published_at: publishedAt,
  }));
  assert.ifError((await service.from("article_variants").insert(articleRows)).error);
  assert.ifError((await service.from("daily_editions").upsert({
    edition_date: today,
    status: "published",
    article_ids: ids.articles,
    coverage: { topics: { 科技: 2, 文化: 1 }, levels: { B1: 3 } },
    published_at: publishedAt,
  })).error);

  const anonymous = await call("daily-feed", "", { method: "GET" });
  assert.equal(anonymous.response.status, 401);

  const feed = await call("daily-feed", readerAuth.token, { method: "GET" });
  assert.equal(feed.response.status, 200, JSON.stringify(feed.data));
  assert.equal(feed.data.primary.sentenceTranslations[baseSentence], "读者无需等待模型即可验证这个句子。");
  assert.equal(feed.data.primary.glossary[0].translation, "核验");
  assert.equal(feed.data.alternatives.length, 2);

  const unavailable = await call("translate", readerAuth.token, {
    body: {
      scope: "word",
      word: "verify",
      sentence: baseSentence,
      contentHash: ids.articles[0],
      qualityMode: "free",
    },
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.data.code, "TRANSLATION_UNAVAILABLE");

  const newUsername = `friend_${suffix}`;
  const created = await call("admin-users", adminAuth.token, {
    body: { action: "create", username: newUsername, cefr: "A2", topics: ["自然"] },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.temporaryPassword.length >= 16, true);
  ids.authUsers.push(created.data.user.id);

  const friendAuth = await signIn(newUsername, created.data.temporaryPassword);
  const blockedBeforeChange = await call("daily-feed", friendAuth.token, { method: "GET" });
  assert.equal(blockedBeforeChange.response.status, 403);
  assert.equal(blockedBeforeChange.data.code, "PASSWORD_CHANGE_REQUIRED");
  const changed = await call("change-password", friendAuth.token, {
    body: { password: "Changed-Internal-Aa1!23456789" },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.reauthenticate, true);
  const oldTemporarySession = await call("daily-feed", friendAuth.token, { method: "GET" });
  assert.equal(oldTemporarySession.response.status, 401);
  const changedAuth = await signIn(newUsername, "Changed-Internal-Aa1!23456789");
  const availableAfterChange = await call("daily-feed", changedAuth.token, { method: "GET" });
  assert.equal(availableAfterChange.response.status, 200, JSON.stringify(availableAfterChange.data));

  const listed = await call("admin-users", adminAuth.token, {
    body: { action: "list" },
  });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.data.users.some((user) => user.username === newUsername));

  const reviewed = await call("admin-content-review", adminAuth.token, {
    body: { articleId: ids.articles[0], decision: "approve", note: "integration check" },
  });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.data));

  const unavailableRun = await call("admin-content-run", adminAuth.token, {
    body: { limit: 500 },
  });
  assert.equal(unavailableRun.response.status, 503);
  assert.equal(unavailableRun.data.code, "GITHUB_ACTIONS_NOT_CONFIGURED");

  const reset = await call("admin-reset-password", adminAuth.token, {
    body: { userId: readerAuth.user.id },
  });
  assert.equal(reset.response.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.sessionsRevoked, true);
  const oldSession = await call("daily-feed", readerAuth.token, { method: "GET" });
  assert.ok([401, 403].includes(oldSession.response.status));

  console.log("Edge integration tests passed: feed, password gate, free-only 503, admin user/content actions, and session revocation.");
} finally {
  await service.from("daily_recommendations").delete().in("primary_article_id", ids.articles);
  await service.from("daily_editions").delete().contains("article_ids", [ids.articles[0]]);
  await service.from("article_variants").delete().in("id", ids.articles);
  await service.from("fact_claims").delete().eq("story_cluster_id", ids.cluster);
  await service.from("story_clusters").delete().eq("id", ids.cluster);
  await service.from("content_candidates").delete().eq("id", ids.candidate);
  await service.from("source_policies").delete().eq("id", ids.source);
  for (const userId of ids.authUsers.reverse()) {
    await service.auth.admin.deleteUser(userId);
  }
}
