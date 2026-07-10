import { App, Button, Input } from "antd";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { beginMfaSetup, enableMfa, getCurrentSession } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

export default function SetupMfaPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const updateUser = useUserStore((state) => state.updateUser);
    const [secret, setSecret] = useState("");
    const [code, setCode] = useState("");
    const [loading, setLoading] = useState(true);
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        beginMfaSetup().then((result) => setSecret(result.secret)).catch((error) => message.error(error instanceof Error ? error.message : "MFA 初始化失败")).finally(() => setLoading(false));
    }, [message]);

    const submit = async () => {
        setLoading(true);
        try {
            await enableMfa(code);
            const { user } = await getCurrentSession();
            updateUser(user);
            message.success("二次验证已启用");
            navigate("/admin", { replace: true });
        } catch (error) { message.error(error instanceof Error ? error.message : "验证码校验失败"); }
        finally { setLoading(false); }
    };

    return (
        <main className="flex h-full items-center justify-center bg-[#eeeeec] px-5 py-8 text-stone-950">
            <section className="w-full max-w-md rounded-lg border border-orange-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-3"><div className="flex size-10 items-center justify-center rounded-md bg-black text-white"><ShieldCheck className="size-5" /></div><div><div className="text-xs font-semibold text-orange-600">超级管理员安全</div><h1 className="text-xl font-black">启用二次验证</h1></div></div>
                <p className="mt-4 text-sm leading-6 text-stone-500">在企业微信、Microsoft Authenticator 或其他 TOTP 验证器中添加下面的密钥，然后输入生成的六位验证码。</p>
                <div className="mt-4 rounded-md bg-stone-100 p-3 font-mono text-sm break-all">{loading && !secret ? "正在生成..." : secret}</div>
                <label className="mt-5 block text-sm font-semibold">六位动态验证码</label>
                <Input className="mt-2" size="large" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" maxLength={6} onPressEnter={submit} />
                <Button className="mt-4" type="primary" size="large" block loading={loading} disabled={code.length !== 6 || !secret} onClick={submit}>验证并启用</Button>
            </section>
        </main>
    );
}
