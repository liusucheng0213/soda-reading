import { createClient, SupabaseClient, User } from "@supabase/supabase-js";

export type UserContext = {
  user: User;
  profile: {
    id: string;
    username: string;
    role: "reader" | "admin";
    cefr: "A2" | "B1" | "B2" | "C1";
    topics: string[];
    daily_minutes: number;
    reminder_time: string;
    review_limit: number;
    must_change_password: boolean;
    is_active: boolean;
    session_version: number;
  };
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
};

export class AuthError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function adminClient(): SupabaseClient {
  return createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export async function requireUser(
  request: Request,
  options: { admin?: boolean; allowPasswordChange?: boolean } = {},
): Promise<UserContext> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new AuthError(401, "AUTH_REQUIRED", "请先登录");
  }

  const url = requiredEnvironment("SUPABASE_URL");
  const anonKey = requiredEnvironment("SUPABASE_ANON_KEY");
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    throw new AuthError(401, "SESSION_EXPIRED", "登录已失效，请重新登录");
  }

  const serviceClient = adminClient();
  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select(
      "id,username,role,cefr,topics,daily_minutes,reminder_time,review_limit,must_change_password,is_active,session_version",
    )
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile) {
    throw new AuthError(403, "ACCOUNT_NOT_READY", "账号资料尚未创建");
  }
  if (!profile.is_active) {
    throw new AuthError(403, "ACCOUNT_DISABLED", "账号已被管理员停用");
  }
  const tokenVersion = Number(userData.user.app_metadata?.session_version ?? 1);
  if (tokenVersion !== Number(profile.session_version)) {
    throw new AuthError(401, "SESSION_REVOKED", "会话已被管理员撤销，请重新登录");
  }
  if (options.admin && profile.role !== "admin") {
    throw new AuthError(403, "ADMIN_REQUIRED", "需要管理员权限");
  }
  if (
    profile.must_change_password &&
    !options.allowPasswordChange
  ) {
    throw new AuthError(403, "PASSWORD_CHANGE_REQUIRED", "首次登录必须先修改临时密码");
  }

  return {
    user: userData.user,
    profile,
    userClient,
    adminClient: serviceClient,
  } as UserContext;
}

export function authFailure(request: Request, error: unknown): Response | null {
  if (!(error instanceof AuthError)) return null;
  return new Response(
    JSON.stringify({ code: error.code, message: error.message, retryable: false }),
    {
      status: error.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function recordEdgeInvocation(
  client: SupabaseClient,
  functionName: string,
): Promise<void> {
  await client.rpc("record_edge_invocation", { edge_function_name: functionName });
}
