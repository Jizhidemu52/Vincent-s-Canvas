import { LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { App, Button, Input } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useUserStore } from "@/stores/use-user-store";

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
                    <label className="block text-sm font-medium">管理员账号</label>
                    <Input size="large" value={loginName} onChange={(event) => setLoginName(event.target.value)} placeholder="请输入管理员账号" />
                    <label className="block text-sm font-medium">登录密码</label>
                    <Input.Password size="large" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" onPressEnter={submit} />
                    <Button type="primary" size="large" block loading={submitting} icon={<LockKeyhole className="size-4" />} onClick={submit}>
                        登录后台
                    </Button>
                    <Button size="large" block icon={<UserRound className="size-4" />} onClick={() => navigate("/login")}>
                        返回设计师登录
                    </Button>
                    <div className="rounded-md bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-900">
                        演示管理员：admin-1 / 123456。普通设计师账号不能进入后台，也不能修改额度、积分价格、模型/API 或工作流配置。
                    </div>
                </div>
            </main>
        </div>
    );
}
