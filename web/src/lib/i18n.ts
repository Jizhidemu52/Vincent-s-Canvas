import { useCallback, useSyncExternalStore } from "react";

export type UiLocale = "zh-CN" | "en-US";
export const UI_LOCALE_KEY = "inchoice.ui-locale";
let locale: UiLocale = "zh-CN";
let employeeInterface = true;
let english: Record<string, string> = {};
let loading: Promise<void> | undefined;
let selection = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const subscribeUiLocale = subscribe;
export const getUiLocale = (): UiLocale => employeeInterface ? locale : "zh-CN";
export function useUiLocale(): UiLocale { return useSyncExternalStore(subscribe, getUiLocale, () => "zh-CN"); }
export function useUiLanguageEnabled() { return useSyncExternalStore(subscribe, () => employeeInterface, () => true); }

function publishLocale() {
    const current = getUiLocale();
    if (typeof document !== "undefined") {
        document.documentElement.lang = current === "en-US" ? "en" : "zh-CN";
        document.title = current === "en-US" ? "Inchoice TruCreate" : "INCHOICE · 无线画布";
    }
    for (const listener of listeners) listener();
}

/** The requested language switch is employee-facing only. Maintenance pages
 * stay Chinese without overwriting the employee's saved language preference. */
export function setUiPathname(pathname: string): void {
    const next = !/^\/admin(?:\/|$)/.test(pathname);
    if (next === employeeInterface) return;
    employeeInterface = next;
    publishLocale();
}

/** Only call with application UI copy. Never translate user documents, model
 * output, names, prompt values or API identifiers. Parameters remain literal. */
export function uiText(source: string, parameters?: Record<string, string | number>): string {
    const translated = getUiLocale() === "en-US" ? english[source] ?? source : source;
    return parameters ? translated.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(parameters, key) ? String(parameters[key]) : match) : translated;
}
export function useUiText() {
    const current = useUiLocale();
    return useCallback((source: string, parameters?: Record<string, string | number>) => uiText(source, parameters), [current]);
}

export async function setUiLocale(next: UiLocale): Promise<void> {
    if (next !== "zh-CN" && next !== "en-US") return;
    const request = ++selection;
    if (next === "en-US") {
        loading ??= import("./i18n/en").then(module => { english = module.default; }).catch(error => { loading = undefined; throw error; });
        await loading;
    }
    if (request !== selection) return;
    locale = next;
    try { localStorage.setItem(UI_LOCALE_KEY, next); } catch { /* Language still works when storage is disabled. */ }
    publishLocale();
}

/** Run only after the OA credential has been removed from the URL. */
export async function initializeUiLocale(): Promise<void> {
    if (typeof window !== "undefined") setUiPathname(window.location.pathname);
    let preferred: UiLocale = "zh-CN";
    try { if (localStorage.getItem(UI_LOCALE_KEY) === "en-US") preferred = "en-US"; } catch { /* Browser default is Chinese. */ }
    try { await setUiLocale(preferred); } catch { await setUiLocale("zh-CN"); }
}
