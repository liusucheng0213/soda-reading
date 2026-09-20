import { AuthError, recordEdgeInvocation, requireUser } from "../_shared/auth.ts";
import { apiError, handleOptions, json, readJson } from "../_shared/http.ts";
import { translateFree, TranslationInput } from "../_shared/translation.ts";

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return apiError(request, 405, "METHOD_NOT_ALLOWED", "仅支持 POST");
  }
  try {
    const context = await requireUser(request);
    await recordEdgeInvocation(context.adminClient, "translate");
    const input = await readJson<TranslationInput>(request);
    if (
      !["word", "sentence"].includes(input.scope) ||
      !input.sentence?.trim() ||
      (input.scope === "word" && !input.word?.trim()) ||
      input.sentence.length > 1_500 ||
      (input.before?.length ?? 0) > 1_500 ||
      (input.after?.length ?? 0) > 1_500 ||
      (input.scope === "word" && (input.word?.length ?? 0) > 80)
    ) {
      return apiError(request, 422, "INVALID_TRANSLATION_REQUEST", "翻译文本不符合要求");
    }
    if (input.qualityMode && input.qualityMode !== "free") {
      return apiError(request, 422, "FREE_MODE_ONLY", "内部版只允许免费翻译线路");
    }
    const { data: quotaAllowed, error: quotaError } = await context.userClient.rpc(
      "consume_translation_quota",
      { max_daily_requests: Number(Deno.env.get("TRANSLATION_DAILY_USER_LIMIT") ?? 500) },
    );
    if (quotaError || quotaAllowed !== true) {
      return apiError(request, 429, "DAILY_FREE_LIMIT_REACHED", "今日免费翻译次数已用完", true);
    }
    const result = await translateFree(context.adminClient, {
      ...input,
      qualityMode: "free",
    });
    return json(request, result);
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(request, error.status, error.code, error.message);
    }
    if ((error as Error).message === "TRANSLATION_UNAVAILABLE") {
      return apiError(
        request,
        503,
        "TRANSLATION_UNAVAILABLE",
        "免费翻译线路暂时不可用，请稍后重试",
        true,
      );
    }
    if ((error as Error).message === "REQUEST_TOO_LARGE") {
      return apiError(request, 413, "REQUEST_TOO_LARGE", "请求内容过大");
    }
    return apiError(request, 500, "INTERNAL_ERROR", "翻译服务暂时异常", true);
  }
});
