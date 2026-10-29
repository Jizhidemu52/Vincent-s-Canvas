import { useEffect } from "react";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useUiLocale } from "./i18n";

export function useAntLocale() {
    const locale = useUiLocale();
    useEffect(() => { dayjs.locale(locale === "en-US" ? "en" : "zh-cn"); }, [locale]);
    return locale === "en-US" ? enUS : zhCN;
}
