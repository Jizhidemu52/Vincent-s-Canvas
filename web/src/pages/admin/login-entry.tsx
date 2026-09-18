import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter } from "react-router-dom";
import AdminLoginPage from "./login";

/** The maintenance login must not initialize employee stores or their local caches. */
export default function AdminLoginEntry() {
    return <BrowserRouter><ConfigProvider locale={zhCN}><App><div className="flex min-h-dvh items-center justify-center"><AdminLoginPage /></div></App></ConfigProvider></BrowserRouter>;
}
