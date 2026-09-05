import { ArrowRight, QrCode, ShieldCheck } from "lucide-react";
import { App, Button, Input } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { loginPortalActions } from "@/lib/login-portal-actions";
import { getWeComLoginUrl } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { deploymentFeatures } from "@/lib/deployment-features";

export default function LoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const login = useUserStore((state) => state.loginWithPassword);
    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const submit = async () => {
        if (!identifier.trim() || !password) { message.warning("请输入账号和密码"); return; }
        setSubmitting(true);
        try {
            const user = await login(identifier, password, "designer");
            navigate(user.mustChangePassword ? "/change-password" : "/", { replace: true });
        } catch (error) { message.error(error instanceof Error ? error.message : "登录失败"); }
        finally { setSubmitting(false); }
    };

    const loginWithWeCom = async () => {
        try {
            window.location.assign((await getWeComLoginUrl("designer")).authorizationUrl);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "企业微信登录暂不可用");
        }
    };

    return (
        <main className="relative flex min-h-full items-center justify-center overflow-hidden bg-[#f6f5f1] px-5 py-10 text-stone-950">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,100,44,0.10),transparent_33rem)]" />
            <section className="relative w-full max-w-md border border-stone-200 bg-white p-7 shadow-[0_20px_70px_rgba(38,31,26,0.10)] sm:p-9">
                <div className="h-1 w-12 bg-[#ff5a1f]" />
                <p className="mt-7 text-xs font-black uppercase tracking-[0.22em] text-[#d94a16]">Vincent&apos;s Canvas</p>
                <h1 className="mt-3 text-4xl font-black tracking-tight text-stone-950">无线画布</h1>
                <p className="mt-4 text-sm leading-6 text-stone-500">{deploymentFeatures.rolePortalsEnabled ? "请通过企业微信完成设计师身份认证；后台配置请从管理员入口进入。" : "登录后进入创作工作台。"}</p>

                <div className="mt-9 grid gap-3">
                    {!deploymentFeatures.rolePortalsEnabled ? <>
                        <Input size="large" aria-label="账号" autoComplete="username" placeholder="账号 / 邮箱 / 工号" value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
                        <Input.Password size="large" aria-label="密码" autoComplete="current-password" placeholder="密码" value={password} onChange={(event) => setPassword(event.target.value)} onPressEnter={() => void submit()} />
                        <Button size="large" block loading={submitting} onClick={() => void submit()}>登录</Button>
                    </> : null}
                    <Button
                        type="primary"
                        size="large"
                        block
                        icon={<QrCode className="size-4" />}
                        onClick={loginWithWeCom}
                        className="!h-12 !rounded-none !bg-[#ff5a1f] !font-bold !shadow-none hover:!bg-[#e84c16]"
                    >
                        {loginPortalActions[0].label}
                    </Button>
                    {deploymentFeatures.rolePortalsEnabled ? <Button
                        size="large"
                        block
                        icon={<ShieldCheck className="size-4" />}
                        onClick={() => navigate("/admin/login")}
                        className="!h-12 !rounded-none !border-stone-300 !font-bold !text-stone-800 !shadow-none hover:!border-stone-950 hover:!text-stone-950"
                    >
                        {loginPortalActions[1].label}
                        <ArrowRight className="ml-1 inline size-4" />
                    </Button> : null}
                </div>

                <p className="mt-6 border-t border-stone-100 pt-4 text-xs leading-5 text-stone-400">企业微信扫码后将自动进入创作工作台。</p>
            </section>
        </main>
    );
}
