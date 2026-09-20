import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceRoleKey) {
  throw new Error("Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const suffix = Date.now().toString(36);
const users = [];

async function createUser(username, role = "reader", mustChangePassword = false) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `${username}@users.soda.invalid`,
    password: "Rls-Test-Aa1!23456789",
    email_confirm: true,
    app_metadata: { role, session_version: 1 },
    user_metadata: { username, cefr: "B1", topics: ["科技"], must_change_password: mustChangePassword },
  });
  assert.ifError(error);
  users.push(data.user.id);
  const { error: updateError } = await admin.from("profiles").update({
    role,
    must_change_password: mustChangePassword,
    is_active: true,
  }).eq("id", data.user.id);
  assert.ifError(updateError);
  return data.user;
}

async function signIn(username) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: `${username}@users.soda.invalid`,
    password: "Rls-Test-Aa1!23456789",
  });
  assert.ifError(error);
  assert.ok(data.session?.access_token);
  return { client, session: data.session };
}

try {
  const anonymous = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signup = await anonymous.auth.signUp({
    email: `blocked-${suffix}@users.soda.invalid`,
    password: "Blocked-Aa1!23456789",
  });
  assert.ok(signup.error, "public signup must be disabled");

  const first = await createUser(`reader_a_${suffix}`);
  const second = await createUser(`reader_b_${suffix}`);
  const temporary = await createUser(`reader_temp_${suffix}`, "reader", true);
  const firstAuth = await signIn(`reader_a_${suffix}`);
  const secondAuth = await signIn(`reader_b_${suffix}`);
  const temporaryAuth = await signIn(`reader_temp_${suffix}`);

  const ownProfiles = await firstAuth.client.from("profiles").select("id,role");
  assert.ifError(ownProfiles.error);
  assert.deepEqual(ownProfiles.data?.map((row) => row.id), [first.id]);

  const otherProfile = await firstAuth.client.from("profiles").select("id").eq("id", second.id);
  assert.ifError(otherProfile.error);
  assert.equal(otherProfile.data?.length, 0);

  const roleEscalation = await firstAuth.client.from("profiles")
    .update({ role: "admin" }).eq("id", first.id);
  assert.ok(roleEscalation.error, "reader must not update role");

  const temporaryProfile = await temporaryAuth.client.from("profiles").select("id");
  assert.ifError(temporaryProfile.error);
  assert.deepEqual(temporaryProfile.data?.map((row) => row.id), [temporary.id]);
  const temporaryWrite = await temporaryAuth.client.from("vocabulary_items").insert({
    user_id: temporary.id,
    content_hash: "temp0123456789ab",
    content_id: "rls-temp",
    word: "temporary",
    translation: "临时的",
    sentence: "This is a temporary password.",
  });
  assert.ok(temporaryWrite.error, "temporary-password user must not access learning tables");

  const vocabularyInsert = await firstAuth.client.from("vocabulary_items").insert({
    user_id: first.id,
    content_hash: "0123456789abcdef",
    content_id: "rls-test",
    word: "bank",
    translation: "河岸",
    sentence: "We sat on the river bank.",
  }).select("id").single();
  assert.ifError(vocabularyInsert.error);

  const secondVocabulary = await secondAuth.client.from("vocabulary_items").select("id");
  assert.ifError(secondVocabulary.error);
  assert.equal(secondVocabulary.data?.length, 0);

  const crossWrite = await secondAuth.client.from("reading_progress").insert({
    user_id: first.id,
    content_hash: "fedcba9876543210",
    progress: 0.5,
  });
  assert.ok(crossWrite.error, "reader must not write another user's progress");

  const { error: disableError } = await admin.from("profiles").update({
    is_active: false,
    session_version: 2,
  }).eq("id", first.id);
  assert.ifError(disableError);
  const { error: revokeError } = await admin.rpc("revoke_user_sessions", {
    target_user_id: first.id,
  });
  assert.ifError(revokeError);

  const disabledRead = await firstAuth.client.from("profiles").select("id");
  assert.ifError(disabledRead.error);
  assert.equal(disabledRead.data?.length, 0, "disabled access token must lose RLS access immediately");

  console.log("Supabase RLS tests passed: signup closed, password gate active, owner isolation active, role escalation blocked, disabled session denied.");
} finally {
  for (const userId of users.reverse()) {
    await admin.auth.admin.deleteUser(userId);
  }
}
