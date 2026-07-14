import { LockKeyhole, QrCode, ShieldCheck, UserRound } from "lucide-react";
import { App, Button, Input } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useUserStore } from "@/stores/use-user-store";
import { getWeComLoginUrl } from "@/services/api/auth";
import { DemoAccountList } from "@/components/demo-account-list";

export default function AdminLoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const login = useUserStore((state) => state.loginWithPassword);
    const [loginName, setLoginName] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        if (!loginName.trim() || !password) { message.warning("请输入管理员账号和密码"); return; }
        setSubmitting(true);
        try {
            const user = await login(loginName, password, "admin");
            message.success("已进入管理员后台");
            navigate(user.mustChangePassword ? "/change-password" : "/admin", { replace: true });
        } catch (error) { message.error(error instanceof Error ? error.message : "登录失败"); }
        finally { setSubmitting(false); }
    };

    const loginWithWeCom = async () => {
        try { window.location.assign((await getWeComLoginUrl("admin")).authorizationUrl); }
        catch (error) { message.error(error instanceof Error ? error.message : "企业微信登录暂不可用"); }
    };

    return (
        <div className="flex h-full items-center justify-center bg-[#eeeeec] px-6 py-10 text-stone-900">
            <main className="w-full max-w-md rounded-md border border-orange-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-md bg-black text-white">
                        <ShieldCheck className="size-5" />
                    </div>
                    <div>
                        <div className="text-xs font-medium text-orange-600">管理员登录</div>
                        <h1 className="text-xl font-semibold">进入后台管理</h1>
                    </div>
                </div>

                <div className="mt-6 space-y-3">
                    <DemoAccountList portal="admin" onSelect={(account) => { setLoginName(account.identifier); setPassword(account.password); }} />
                    <label className="block text-sm font-medium">管理员账号</label>
                    <Input size="large" value={loginName} onChange={(event) => setLoginName(event.target.value)} placeholder="请输入管理员账号" />
                    <label className="block text-sm font-medium">登录密码</label>
                    <Input.Password size="large" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" onPressEnter={submit} />
                    <Button type="primary" size="large" block loading={submitting} icon={<LockKeyhole className="size-4" />} onClick={submit}>
                        登录后台
                    </Button>
                    <Button size="large" block icon={<QrCode className="size-4" />} onClick={loginWithWeCom}>企业微信扫码登录</Button>
                    <Button size="large" block icon={<UserRound className="size-4" />} onClick={() => navigate("/login")}>
                        返回设计师登录
                    </Button>
                </div>
            </main>
        </div>
    );
}
