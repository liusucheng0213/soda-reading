import { AuthError, recordEdgeInvocation, requireUser } from "../_shared/auth.ts";
import { normalizeUsername, placeholderEmail, temporaryPassword, validUsername } from "../_shared/admin.ts";
import { apiError, handleOptions, json, readJson } from "../_shared/http.ts";

type RequestBody = {
  action?: "create" | "list" | "set_status" | "revoke_sessions";
  username?: string;
  displayName?: string;
  cefr?: "A2" | "B1" | "B2" | "C1";
  topics?: string[];
  dailyMinutes?: number;
  userId?: string;
  active?: boolean;
};

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return apiError(request, 405, "METHOD_NOT_ALLOWED", "仅支持 POST");
  }
  try {
    const context = await requireUser(request, { admin: true });
    await recordEdgeInvocation(context.adminClient, "admin-users");
    const body = await readJson<RequestBody>(request);
    const action = body.action ?? "create";
    if (action === "list") {
      const { data, error } = await context.adminClient
        .from("profiles")
        .select("id,username,display_name,role,cefr,topics,daily_minutes,review_limit,must_change_password,is_active,created_at,updated_at,user_devices(id,device_name,platform,last_active_at,revoked_at)")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return json(request, { users: data ?? [] });
    }
    if (action === "create") {
      const username = normalizeUsername(body.username ?? "");
      if (!validUsername(username)) {
        return apiError(request, 422, "INVALID_USERNAME", "用户名需为 3–24 位小写字母、数字或下划线");
      }
      const cefr = ["A2", "B1", "B2", "C1"].includes(body.cefr ?? "") ? body.cefr : "B1";
      const topics = (body.topics ?? ["科技"]).filter((value) =>
        ["科技", "文化", "商业", "自然", "健康", "历史"].includes(value)
      ).slice(0, 6);
      const { count, error: countError } = await context.adminClient
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "reader");
      if (countError) throw countError;
      if ((count ?? 0) >= 6) {
        return apiError(request, 409, "INTERNAL_USER_LIMIT", "内部读者账号最多 6 个");
      }
      const password = temporaryPassword();
      const { data: created, error: createError } = await context.adminClient.auth.admin.createUser({
        email: placeholderEmail(username),
        password,
        email_confirm: true,
        app_metadata: { role: "reader", session_version: 1 },
        user_metadata: {
          username,
          display_name: body.displayName?.trim() || username,
          cefr,
          topics,
          must_change_password: true,
        },
      });
      if (createError || !created.user) {
        if (createError?.message?.toLowerCase().includes("already")) {
          return apiError(request, 409, "USERNAME_EXISTS", "用户名已存在");
        }
        throw createError;
      }
      const { error: profileError } = await context.adminClient.from("profiles").upsert({
        id: created.user.id,
        username,
        display_name: body.displayName?.trim() || username,
        role: "reader",
        cefr,
        topics,
        daily_minutes: Math.min(120, Math.max(5, body.dailyMinutes ?? 10)),
        must_change_password: true,
        is_active: true,
        session_version: 1,
      }, { onConflict: "id" });
      if (profileError) {
        await context.adminClient.auth.admin.deleteUser(created.user.id);
        throw profileError;
      }
      return json(request, {
        user: { id: created.user.id, username, cefr, topics },
        temporaryPassword: password,
        mustChangePassword: true,
      }, 201);
    }

    if (!body.userId) {
      return apiError(request, 422, "USER_ID_REQUIRED", "缺少用户 ID");
    }
    const { data: profile, error: profileError } = await context.adminClient
      .from("profiles")
      .select("*")
      .eq("id", body.userId)
      .maybeSingle();
    if (profileError || !profile) return apiError(request, 404, "USER_NOT_FOUND", "用户不存在");
    if (profile.role === "admin" && profile.id === context.user.id) {
      return apiError(request, 409, "SELF_LOCKOUT_BLOCKED", "不能停用或撤销当前管理员自己的会话");
    }
    const nextVersion = Number(profile.session_version) + 1;
    const { data: authUser, error: authError } =
      await context.adminClient.auth.admin.getUserById(body.userId);
    if (authError || !authUser.user) throw authError;
    const { error: updateAuthError } = await context.adminClient.auth.admin.updateUserById(
      body.userId,
      {
        app_metadata: {
          ...authUser.user.app_metadata,
          session_version: nextVersion,
        },
      },
    );
    if (updateAuthError) throw updateAuthError;
    const update = action === "set_status"
      ? { is_active: body.active === true, session_version: nextVersion }
      : { session_version: nextVersion };
    const { error: updateProfileError } = await context.adminClient
      .from("profiles").update(update).eq("id", body.userId);
    if (updateProfileError) throw updateProfileError;
    const { data: removedSessions, error: revokeError } = await context.adminClient.rpc(
      "revoke_user_sessions",
      { target_user_id: body.userId },
    );
    if (revokeError) throw revokeError;
    if (action === "revoke_sessions" || action === "set_status") {
      await context.adminClient.from("user_devices")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", body.userId)
        .is("revoked_at", null);
    }
    return json(request, {
      updated: true,
      userId: body.userId,
      isActive: action === "set_status" ? body.active === true : profile.is_active,
      sessionsRevoked: true,
      revokedSessionCount: removedSessions ?? 0,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(request, error.status, error.code, error.message);
    }
    if ((error as Error).message === "REQUEST_TOO_LARGE") {
      return apiError(request, 413, "REQUEST_TOO_LARGE", "请求内容过大");
    }
    return apiError(request, 500, "ADMIN_USER_FAILED", "账号操作失败");
  }
});
