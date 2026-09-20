import { AuthError, recordEdgeInvocation, requireUser } from "../_shared/auth.ts";
import { apiError, handleOptions, json, readJson } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return apiError(request, 405, "METHOD_NOT_ALLOWED", "仅支持 POST");
  }
  try {
    const context = await requireUser(request, { admin: true });
    await recordEdgeInvocation(context.adminClient, "admin-content-run");
    const body = await readJson<{ limit?: number }>(request);
    const repository = Deno.env.get("GITHUB_REPOSITORY") ?? "";
    const token = Deno.env.get("GITHUB_WORKFLOW_TOKEN") ?? "";
    const ref = Deno.env.get("GITHUB_WORKFLOW_REF") ?? "main";
    if (!repository || !token) {
      return apiError(
        request,
        503,
        "GITHUB_ACTIONS_NOT_CONFIGURED",
        "尚未配置 GitHub Actions 手动触发",
      );
    }
    const runId = crypto.randomUUID();
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/workflows/daily-content.yml/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref,
          inputs: {
            run_id: runId,
            limit: String(Math.min(2_000, Math.max(500, body.limit ?? 500))),
          },
        }),
      },
    );
    if (!response.ok) {
      return apiError(
        request,
        502,
        "GITHUB_DISPATCH_FAILED",
        "GitHub Actions 未接受任务，请检查令牌和仓库设置",
        true,
      );
    }
    return json(request, {
      runId,
      status: "queued",
      message: "内容任务已提交到 GitHub Actions",
    }, 202);
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 500, "CONTENT_RUN_FAILED", "无法触发内容任务", true);
  }
});
