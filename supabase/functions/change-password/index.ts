import { AuthError, recordEdgeInvocation, requireUser } from "../_shared/auth.ts";
import { apiError, handleOptions, json, readJson } from "../_shared/http.ts";

function validPassword(value: string): boolean {
  return value.length >= 16 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^a-zA-Z0-9]/.test(value);
}

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return apiError(request, 405, "METHOD_NOT_ALLOWED", "仅支持 POST");
  }
  try {
    const context = await requireUser(request, { allowPasswordChange: true });
    await recordEdgeInvocation(context.adminClient, "change-password");
    const { password } = await readJson<{ password: string }>(request);
    if (!validPassword(password ?? "")) {
      return apiError(
        request,
        422,
        "WEAK_PASSWORD",
        "新密码至少 16 位，并包含大小写字母、数字和符号",
      );
    }
    const { error } = await context.adminClient.auth.admin.updateUserById(
      context.user.id,
      { password },
    );
    if (error) throw error;
    const { error: profileError } = await context.adminClient
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", context.user.id);
    if (profileError) throw profileError;
    return json(request, { changed: true, reauthenticate: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 500, "PASSWORD_CHANGE_FAILED", "密码修改失败，请联系管理员");
  }
});
