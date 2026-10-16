import { App, Button, Input } from "antd";
import { LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { useRef, useState } from "react";

import { useUserStore } from "@/stores/use-user-store";

export default function LoginPage() {
    const { message } = App.useApp();
    const login = useUserStore((state) => state.loginWithPassword);
    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);

    const submit = async () => {
        if (submittingRef.current) return;
        if (!identifier.trim() || !password) { message.warning("请输入个人账号和密码"); return; }
        submittingRef.current = true; setSubmitting(true);
        try {
            const user = await login(identifier.trim(), password, "designer");
            // Bootstrap a fresh page only after the server has confirmed identity.
            // No previous account's singleton or persistence queue is reused.
            window.location.assign(user.mustChangePassword ? "/change-password" : "/");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败，请重试");
        } finally {
            submittingRef.current = false; setSubmitting(false);
        }
    };

    return <main className="flex min-h-dvh w-full items-center justify-center bg-background px-6 py-10 text-foreground">
        <section className="wb-surface w-full max-w-md p-6">
            <div className="flex items-center gap-3">
                <UserRound className="size-8 shrink-0" />
                <div><div className="text-xs text-[var(--muted-foreground)]">个人创作工作台</div><h1 className="text-xl font-semibold">登录你的账号</h1></div>
            </div>
            <p className="mt-4 text-sm text-[var(--muted-foreground)]">每人使用独立账号，作品、聊天记录和积分按账号分别管理。账号由管理员开通。</p>
            <form className="mt-6 space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
                <label htmlFor="personal-login-identifier" className="block text-sm font-medium">个人账号</label>
                <Input id="personal-login-identifier" size="large" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="账号、邮箱或工号" autoComplete="username" disabled={submitting} />
                <label htmlFor="personal-login-password" className="block text-sm font-medium">登录密码</label>
                <Input.Password id="personal-login-password" size="large" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" autoComplete="current-password" disabled={submitting} />
                <Button htmlType="submit" type="primary" size="large" block loading={submitting} icon={<LockKeyhole className="size-4" />}>登录工作台</Button>
                <Button size="large" block icon={<ShieldCheck className="size-4" />} disabled={submitting} onClick={() => window.location.assign("/admin/login")}>管理员入口</Button>
            </form>
        </section>
    </main>;
}
