import { Button, Input, Popover } from "antd";
import { useEffect, useRef, useState } from "react";
import { deploymentFeatures } from "@/lib/deployment-features";
import { uiText, useUiLocale } from "@/lib/i18n";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

/** A user-opened recovery control, never a forced modal or a page lock. */
export function SessionRecoveryControl() {
    useUiLocale();
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const pending = useRef(false);
    const oa = deploymentFeatures.oaLoginEnabled && !isAdminRole(user?.role);
    useEffect(() => { if (status !== "expired") { setOpen(false); setPassword(""); setError(""); } }, [status]);
    const resume = async (checkOnly = false) => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError("");
        try {
            if (checkOnly) await useUserStore.getState().hydrateSession();
            else await useUserStore.getState().reauthenticate(password);
            if (useUserStore.getState().status === "expired") setError(uiText("尚未恢复登录，请完成登录后再试。"));
        } catch { setError(uiText("登录未成功，请检查密码或网络后重试。")); }
        finally { setPassword(""); pending.current = false; setBusy(false); }
    };
    if (status !== "expired" || !user) return null;
    return <div className="fixed right-4 top-16 z-[900]" data-canvas-shortcuts="ignore" data-canvas-no-zoom>
        <Popover trigger="click" placement="bottomRight" open={open} onOpenChange={setOpen} destroyOnHidden
            content={<section aria-label={uiText("恢复登录面板")} className="w-[min(360px,calc(100vw-48px))]" onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") setOpen(false); }}>
        <div className="mb-3 flex items-center justify-between"><strong>{uiText("恢复登录")}</strong><Button type="text" size="small" onClick={() => setOpen(false)}>{uiText("关闭")}</Button></div>
        <p className="mb-4 text-sm">{uiText("草稿仍保留，可继续编辑。云端保存和生成需恢复同一账号登录，不会自动重新提交生成。")}</p>
        {oa ? <><p className="mb-4 text-sm">{uiText("请在新窗口从企业微信的公司 OA 重新进入画布，保留此页面；完成后回来检查登录。")}</p><Button type="primary" loading={busy} onClick={() => void resume(true)}>{uiText("我已从 OA 登录，继续检查")}</Button></>
            : <form onSubmit={event => { event.preventDefault(); if (password) void resume(); }}>
                <p className="mb-3 text-sm">{uiText("当前账号：{name}", { name: user?.displayName || user?.username || "" })}</p>
                <label className="mb-2 block text-sm" htmlFor="session-resume-password">{uiText("登录密码")}</label>
                <Input.Password id="session-resume-password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" disabled={busy} />
                <a className="mt-3 block text-sm underline" href={isAdminRole(user.role) ? "/admin/login" : "/login"} target="_blank" rel="noopener noreferrer">{uiText("在新窗口登录（支持原登录方式）")}</a>
                <div className="mt-4 flex flex-wrap gap-2"><Button type="primary" htmlType="submit" loading={busy} disabled={!password}>{uiText("重新登录并继续")}</Button><Button disabled={busy} onClick={() => void resume(true)}>{uiText("已在其他窗口登录")}</Button></div>
            </form>}
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    </section>}><Button size="small">{uiText("恢复登录")}</Button></Popover></div>;
}
