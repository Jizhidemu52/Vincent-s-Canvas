import { getUiLocale, uiText } from "@/lib/i18n";

/** Direct-call component harnesses do not mount React. Use the real text
 * translator while keeping subscription hooks outside these behavior tests. */
export const i18nHarness = { getUiLocale, uiText, useUiLocale: getUiLocale, useUiText: () => uiText, setUiPathname: () => undefined, useUiLanguageEnabled: () => true };
