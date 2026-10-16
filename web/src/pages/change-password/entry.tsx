import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter } from "react-router-dom";
import ChangePasswordPage from "./index";

/** First-login password changes complete before any employee cache can initialize. */
export default function PasswordChangeEntry() {
    return <BrowserRouter><ConfigProvider locale={zhCN}><App><ChangePasswordPage /></App></ConfigProvider></BrowserRouter>;
}
