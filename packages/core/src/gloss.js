const REFERENT_PREFIX = /^(?:文中)?指代/;

export function isReferentGloss(result) {
  const translation = String(result?.translation || "").trim();
  return Boolean(result?.referent) || REFERENT_PREFIX.test(translation);
}

export function hasCommonGloss(result) {
  return Boolean(
    result?.commonTranslation
    && result.commonTranslation !== result.translation
    && !isReferentGloss(result),
  );
}

export function glossText(result) {
  const translation = String(result?.translation || "").trim();
  if (!translation) return "";
  if (!isReferentGloss(result)) return translation;
  const body = translation.replace(/^(?:文中指代|指代)\s*/, "");
  return body ? `文中指代 ${body}` : translation;
}
