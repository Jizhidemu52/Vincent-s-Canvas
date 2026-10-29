import { App, ConfigProvider } from "antd";
import { useAntLocale } from "@/lib/use-ant-locale";
import { BrowserRouter } from "react-router-dom";
import ChangePasswordPage from "./index";

/** First-login password changes complete before any employee cache can initialize. */
export default function PasswordChangeEntry() {
    const locale = useAntLocale();
    return <BrowserRouter><ConfigProvider locale={locale}><App><ChangePasswordPage /></App></ConfigProvider></BrowserRouter>;
}
