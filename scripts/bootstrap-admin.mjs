import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const username = (process.env.SODA_ADMIN_USERNAME ?? "admin").trim().toLowerCase();
const suppliedPassword = process.env.SODA_ADMIN_TEMP_PASSWORD;

if (!url || !serviceKey) {
  console.error("需要 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY。");
  process.exit(1);
}
if (!/^[a-z0-9_]{3,24}$/.test(username)) {
  console.error("管理员用户名需为 3–24 位小写字母、数字或下划线。");
  process.exit(1);
}

const generated = `Aa1!${randomBytes(15).toString("base64url")}`;
const password = suppliedPassword || generated;
if (password.length < 16) {
  console.error("临时密码至少 16 位。");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = `${username}@users.soda.invalid`;
const { data: existing } = await supabase.from("profiles")
  .select("id,username,role").eq("username", username).maybeSingle();
if (existing) {
  console.error(`账号 ${username} 已存在，未进行覆盖。`);
  process.exit(2);
}
const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  app_metadata: { role: "admin", session_version: 1 },
  user_metadata: {
    username,
    display_name: "苏打阅读管理员",
    cefr: "B2",
    topics: ["科技", "文化", "自然"],
    must_change_password: true,
  },
});
if (error || !data.user) {
  console.error(error?.message ?? "管理员创建失败");
  process.exit(3);
}
const { error: profileError } = await supabase.from("profiles").upsert({
  id: data.user.id,
  username,
  display_name: "苏打阅读管理员",
  role: "admin",
  cefr: "B2",
  topics: ["科技", "文化", "自然"],
  daily_minutes: 10,
  review_limit: 20,
  must_change_password: true,
  is_active: true,
  session_version: 1,
});
if (profileError) {
  await supabase.auth.admin.deleteUser(data.user.id);
  console.error(profileError.message);
  process.exit(4);
}
console.log(`管理员用户名: ${username}`);
console.log(`一次性临时密码: ${password}`);
console.log("首次登录后必须立即修改；请勿把服务角色密钥交给其他人。");
