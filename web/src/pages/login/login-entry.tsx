import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import LoginPage from "./index";

/** This isolated entry deliberately does not import the router or any workspace store. */
export default function PasswordLoginEntry() {
    return <ConfigProvider locale={zhCN}><App><LoginPage /></App></ConfigProvider>;
}
