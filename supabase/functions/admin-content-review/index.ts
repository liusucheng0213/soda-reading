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
    await recordEdgeInvocation(context.adminClient, "admin-content-review");
    const { articleId, decision, note } = await readJson<{
      articleId: string;
      decision: "approve" | "reject";
      note?: string;
    }>(request);
    if (!articleId || !["approve", "reject"].includes(decision)) {
      return apiError(request, 422, "INVALID_REVIEW", "审核参数不完整");
    }
    const { data: article, error: readError } = await context.adminClient
      .from("article_variants")
      .select("id,quality_score,risk_flags,review_status")
      .eq("id", articleId)
      .maybeSingle();
    if (readError || !article) return apiError(request, 404, "ARTICLE_NOT_FOUND", "文章不存在");
    if (decision === "approve" && Number(article.quality_score) < 85) {
      return apiError(request, 409, "QUALITY_GATE_FAILED", "质量分低于 85，不能发布");
    }
    const { error: updateError } = await context.adminClient
      .from("article_variants")
      .update({
        review_status: decision === "approve" ? "approved" : "rejected",
        review_note: String(note ?? "").slice(0, 500),
      })
      .eq("id", articleId);
    if (updateError) throw updateError;
    return json(request, {
      articleId,
      reviewStatus: decision === "approve" ? "approved" : "rejected",
      riskFlags: article.risk_flags ?? [],
      reviewedBy: context.profile.username,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 500, "CONTENT_REVIEW_FAILED", "审核保存失败", true);
  }
});
