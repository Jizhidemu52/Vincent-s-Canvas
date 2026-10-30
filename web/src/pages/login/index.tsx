import { uiText, useUiLocale } from "@/lib/i18n";
import { App, Button, Input } from "antd";
import { LockKeyhole, QrCode, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getAuthMethods, getWeComLoginUrl, type AuthMethods } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { currentLoginReturn } from "@/lib/login-return";

export default function LoginPage() {
    useUiLocale();
    const { message } = App.useApp();
    const login = useUserStore((state) => state.loginWithPassword);
    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const [authMethods, setAuthMethods] = useState<AuthMethods | null>(null);
    const [wecomOpening, setWecomOpening] = useState(false);
    const [wecomError, setWecomError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const scanRequested = new URLSearchParams(window.location.search).get("scan") === "1";
        const prepareLogin = async () => {
            try {
                const methods = await getAuthMethods();
                if (!active) return;
                setAuthMethods(methods);
                if (!scanRequested || submittingRef.current) return;
                if (!methods.wecom || !methods.wecomLoginUrl) {
                    setWecomError(uiText("企业微信扫码登录暂不可用，请使用个人账号登录"));
                    return;
                }
                setWecomOpening(true);
                // The state cookie must be created on the configured callback origin,
                // including its protocol and port, not an alternate entry address.
                const loginUrl = new URL(methods.wecomLoginUrl, window.location.href);
                if (loginUrl.origin !== window.location.origin) {
                    window.location.replace(loginUrl.href);
                    return;
                }
                const { authorizationUrl } = await getWeComLoginUrl("designer");
                if (active) window.location.assign(authorizationUrl);
            } catch (error) {
                if (active && scanRequested) setWecomError(error instanceof Error ? error.message : uiText("企业微信登录暂不可用"));
            } finally {
                if (active) setWecomOpening(false);
            }
        };
        void prepareLogin();
        return () => { active = false; };
    }, []);

    const submit = async () => {
        if (submittingRef.current) return;
        if (!identifier.trim() || !password) { message.warning(uiText("请输入个人账号和密码")); return; }
        submittingRef.current = true; setSubmitting(true);
        try {
            const user = await login(identifier.trim(), password, "designer");
            // Bootstrap a fresh page only after the server has confirmed identity.
            // No previous account's singleton or persistence queue is reused.
            const returnTo = currentLoginReturn();
            window.location.assign(user.mustChangePassword ? `/change-password?returnTo=${encodeURIComponent(returnTo)}` : returnTo);
        } catch (error) {
            message.error(error instanceof Error ? error.message : uiText("登录失败，请重试"));
        } finally {
            submittingRef.current = false; setSubmitting(false);
        }
    };

    return <main className="flex min-h-dvh w-full items-center justify-center bg-background px-6 py-10 text-foreground">
        <section className="wb-surface w-full max-w-md p-6">
            <div className="mb-3 flex justify-end"><LanguageSwitch /></div>
            <div className="mb-7 flex justify-center"><InchoiceBrand className="!w-[240px]" /></div>
            <div className="flex items-center gap-3">
                <UserRound className="size-8 shrink-0" />
                <div><div className="text-xs text-[var(--muted-foreground)]">{uiText("个人创作工作台")}</div><h1 className="text-xl font-semibold">{uiText("登录你的账号")}</h1></div>
            </div>
            <p className="mt-4 text-sm text-[var(--muted-foreground)]">{uiText("每人使用独立账号，作品、聊天记录和积分按账号分别管理。账号由管理员开通。")}</p>
            {authMethods?.wecom && authMethods.wecomLoginUrl && !wecomError && <div className="mt-6">
                <Button size="large" block icon={<QrCode className="size-4" />} loading={wecomOpening} disabled={submitting} onClick={() => window.location.assign(authMethods.wecomLoginUrl!)}>{uiText("企业微信扫码登录")}</Button>
            </div>}
            {wecomOpening && <p role="status" className="mt-3 text-sm text-[var(--muted-foreground)]">{uiText("正在打开企业微信扫码登录")}</p>}
            {wecomError && <div className="mt-4 space-y-2">
                <p role="alert" className="text-sm">{wecomError}</p>
                {(!authMethods || authMethods.wecom) && <Button onClick={() => window.location.reload()}>{uiText("重试扫码登录")}</Button>}
                <Button type="link" onClick={() => window.location.replace("/login")}>{uiText("返回密码登录")}</Button>
            </div>}
            <form className="mt-6 space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
                <label htmlFor="personal-login-identifier" className="block text-sm font-medium">{uiText("个人账号")}</label>
                <Input id="personal-login-identifier" size="large" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder={uiText("账号、邮箱或工号")} autoComplete="username" disabled={submitting || wecomOpening} />
                <label htmlFor="personal-login-password" className="block text-sm font-medium">{uiText("登录密码")}</label>
                <Input.Password id="personal-login-password" size="large" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={uiText("请输入密码")} autoComplete="current-password" disabled={submitting || wecomOpening} />
                <Button htmlType="submit" type="primary" size="large" block loading={submitting} disabled={wecomOpening} icon={<LockKeyhole className="size-4" />}>{uiText("登录工作台")}</Button>
                <Button size="large" block icon={<ShieldCheck className="size-4" />} disabled={submitting || wecomOpening} onClick={() => window.location.assign("/admin/login")}>{uiText("管理员入口")}</Button>
            </form>
        </section>
    </main>;
}
