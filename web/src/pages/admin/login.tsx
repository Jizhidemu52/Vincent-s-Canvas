import { LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { App, Button, Input } from "antd";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { currentLoginReturn } from "@/lib/login-return";

export default function AdminLoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const login = useUserStore((state) => state.loginWithPassword);
    const [loginName, setLoginName] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);

    const submit = async () => {
        if (submittingRef.current) return;
        if (!loginName.trim() || !password) { message.warning("请输入管理员账号和密码"); return; }
        submittingRef.current = true; setSubmitting(true);
        try {
            const user = await login(loginName, password, "admin");
            message.success("登录成功");
            const returnTo = currentLoginReturn("/admin");
            const destination = user.mustChangePassword ? `/change-password?returnTo=${encodeURIComponent(returnTo)}` : isAdminRole(user.role) ? returnTo : "/";
            if (deploymentFeatures.authenticationEnabled) window.location.assign(destination);
            else navigate(destination, { replace: true });
        } catch (error) { message.error(error instanceof Error ? error.message : "登录失败"); }
        finally { submittingRef.current = false; setSubmitting(false); }
    };

    return (
        <div className="flex h-full items-center justify-center bg-background px-6 py-10 text-foreground">
            <main className="w-full max-w-md rounded-md border border-border bg-card p-6 shadow-sm">
                <div className="mb-7 flex justify-center"><InchoiceBrand className="!w-[240px]" /></div>
                <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-md bg-foreground text-background">
                        <ShieldCheck className="size-5" />
                    </div>
                    <div>
                        <div className="text-xs font-medium text-orange-600">管理员维护</div>
                        <h1 className="text-xl font-semibold">进入后台管理</h1>
                        <p className="mt-1 text-xs text-stone-500">管理员在此登录管理中心；超级管理员也可进入自己的个人工作台。{deploymentFeatures.oaLoginEnabled ? "员工请从公司 OA 进入。" : "设计师请使用个人账号登录。"}</p>
                    </div>
                </div>

                <form className="mt-6 space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
                    <label htmlFor="admin-login-name" className="block text-sm font-medium">管理员账号</label>
                    <Input id="admin-login-name" name="username" required size="large" value={loginName} onChange={(event) => setLoginName(event.target.value)} placeholder="请输入管理员账号" autoComplete="username" />
                    <label htmlFor="admin-login-password" className="block text-sm font-medium">登录密码</label>
                    <Input.Password id="admin-login-password" name="password" required size="large" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" autoComplete="current-password" />
                    <Button type="primary" htmlType="submit" size="large" block loading={submitting} icon={<LockKeyhole className="size-4" />}>
                        登录后台
                    </Button>
                    <Button size="large" block icon={<UserRound className="size-4" />} onClick={() => deploymentFeatures.authenticationEnabled ? window.location.assign(deploymentFeatures.oaLoginEnabled ? "/" : "/login") : navigate("/")}>
                        返回工作台
                    </Button>
                </form>
            </main>
        </div>
    );
}
