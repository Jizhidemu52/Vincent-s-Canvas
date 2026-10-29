import { App, ConfigProvider } from "antd";
import { useAntLocale } from "@/lib/use-ant-locale";
import LoginPage from "./index";

/** This isolated entry deliberately does not import the router or any workspace store. */
export default function PasswordLoginEntry() {
    const locale = useAntLocale();
    return <ConfigProvider locale={locale}><App><LoginPage /></App></ConfigProvider>;
}
