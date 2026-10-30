import { Button, Input, Modal } from "antd";
import { useRef, useState } from "react";
import { deploymentFeatures } from "@/lib/deployment-features";
import { uiText, useUiLocale } from "@/lib/i18n";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

/** Keep tools mounted behind an inert boundary; only the same verified owner may resume. */
export function SessionExpiredDialog() {
    useUiLocale();
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const oa = deploymentFeatures.oaLoginEnabled && !isAdminRole(user?.role);
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
    return <Modal open={status === "expired" && Boolean(user)} title={uiText("登录已过期")} footer={null} closable={false} maskClosable={false} keyboard={false} centered destroyOnHidden>
        <p className="mb-4 text-sm">{uiText("当前页面已锁定，未提交的内容仍保留在此页面。恢复同一账号登录后可继续，不会自动重新提交生成。")}</p>
        {oa ? <><p className="mb-4 text-sm">{uiText("请在新窗口从企业微信的公司 OA 重新进入画布，保留此页面；完成后回来检查登录。")}</p><Button type="primary" loading={busy} onClick={() => void resume(true)}>{uiText("我已从 OA 登录，继续检查")}</Button></>
            : <form onSubmit={event => { event.preventDefault(); if (password) void resume(); }}>
                <p className="mb-3 text-sm">{uiText("当前账号：{name}", { name: user?.displayName || user?.username || "" })}</p>
                <label className="mb-2 block text-sm" htmlFor="session-resume-password">{uiText("登录密码")}</label>
                <Input.Password id="session-resume-password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" autoFocus disabled={busy} />
                <div className="mt-4 flex flex-wrap gap-2"><Button type="primary" htmlType="submit" loading={busy} disabled={!password}>{uiText("重新登录并继续")}</Button><Button disabled={busy} onClick={() => void resume(true)}>{uiText("已在其他窗口登录")}</Button></div>
            </form>}
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    </Modal>;
}
