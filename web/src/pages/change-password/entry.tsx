import { App, ConfigProvider } from "antd";
import { useAntLocale } from "@/lib/use-ant-locale";
import { BrowserRouter } from "react-router-dom";
import { getAntThemeConfig } from "@/lib/app-theme";
import ChangePasswordPage from "./index";

/** First-login password changes complete before any employee cache can initialize. */
export default function PasswordChangeEntry() {
    const locale = useAntLocale();
    return <BrowserRouter><ConfigProvider locale={locale} theme={getAntThemeConfig(false)}><App><ChangePasswordPage /></App></ConfigProvider></BrowserRouter>;
}
