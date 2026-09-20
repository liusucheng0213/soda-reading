import { AuthError, recordEdgeInvocation, requireUser } from "../_shared/auth.ts";
import { temporaryPassword } from "../_shared/admin.ts";
import { apiError, handleOptions, json, readJson } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return apiError(request, 405, "METHOD_NOT_ALLOWED", "仅支持 POST");
  }
  try {
    const context = await requireUser(request, { admin: true });
    await recordEdgeInvocation(context.adminClient, "admin-reset-password");
    const { userId, username } = await readJson<{ userId?: string; username?: string }>(request);
    let query = context.adminClient.from("profiles")
      .select("id,username,session_version,role");
    query = userId ? query.eq("id", userId) : query.eq("username", username?.trim().toLowerCase() ?? "");
    const { data: profile, error: profileError } = await query.maybeSingle();
    if (profileError || !profile) return apiError(request, 404, "USER_NOT_FOUND", "用户不存在");
    if (profile.id === context.user.id) {
      return apiError(request, 409, "SELF_RESET_BLOCKED", "请在个人设置中修改管理员自己的密码");
    }
    const password = temporaryPassword();
    const nextVersion = Number(profile.session_version) + 1;
    const { data: authUser, error: getError } =
      await context.adminClient.auth.admin.getUserById(profile.id);
    if (getError || !authUser.user) throw getError;
    const { error: authError } = await context.adminClient.auth.admin.updateUserById(profile.id, {
      password,
      app_metadata: { ...authUser.user.app_metadata, session_version: nextVersion },
    });
    if (authError) throw authError;
    const { error: updateError } = await context.adminClient.from("profiles").update({
      must_change_password: true,
      session_version: nextVersion,
    }).eq("id", profile.id);
    if (updateError) throw updateError;
    const { data: removedSessions, error: revokeError } = await context.adminClient.rpc(
      "revoke_user_sessions",
      { target_user_id: profile.id },
    );
    if (revokeError) throw revokeError;
    await context.adminClient.from("user_devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", profile.id)
      .is("revoked_at", null);
    return json(request, {
      user: { id: profile.id, username: profile.username },
      temporaryPassword: password,
      mustChangePassword: true,
      sessionsRevoked: true,
      revokedSessionCount: removedSessions ?? 0,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 500, "PASSWORD_RESET_FAILED", "重置密码失败");
  }
});
