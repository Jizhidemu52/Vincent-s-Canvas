import { LogIn, QrCode, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { App, Button, Input } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { getWeComLoginUrl } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

export default function LoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const login = useUserStore((state) => state.loginWithPassword);
    const [loginName, setLoginName] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const submitDesignerLogin = async () => {
        if (!loginName.trim() || !password) { message.warning("请输入账号和密码"); return; }
        setSubmitting(true);
        try {
            const user = await login(loginName, password, "designer");
            message.success(`已进入设计师工作台：${user.displayName}`);
            navigate(user.mustChangePassword ? "/change-password" : "/", { replace: true });
        } catch (error) { message.error(error instanceof Error ? error.message : "登录失败"); }
        finally { setSubmitting(false); }
    };

    const loginWithWeCom = async () => {
        try { window.location.assign((await getWeComLoginUrl("designer")).authorizationUrl); }
        catch (error) { message.error(error instanceof Error ? error.message : "企业微信登录暂不可用"); }
    };

    return (
        <main className="flex h-full overflow-y-auto bg-[#eeeeec] px-5 py-8 text-stone-950">
            <section className="mx-auto grid w-full max-w-5xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="relative overflow-hidden rounded-lg bg-[#ff5a1f] p-8 text-white">
                    <span className="inline-flex h-7 items-center rounded-sm bg-black px-2 text-xs font-black uppercase">Login</span>
                    <h1 className="mt-6 max-w-xl text-4xl font-black leading-tight tracking-normal md:text-5xl">无线画布登录入口</h1>
                    <p className="mt-4 max-w-2xl text-sm font-semibold leading-6 text-white/90">设计师和管理员分开进入。设计师只看到创作工具和项目；管理员拥有后台最高权限，可以调额度、价格规则、模型/API 和审计记录。</p>
                    <div className="mt-8 grid gap-3 sm:grid-cols-3">
                        {[
                            ["设计师", "创作、素材、画布"],
                            ["管理员", "额度、积分、模型"],
                            ["权限隔离", "入口和配置分开"],
                        ].map(([title, desc]) => (
                            <div key={title} className="rounded-md bg-white/12 p-3 ring-1 ring-white/20">
                                <div className="text-sm font-black">{title}</div>
                                <div className="mt-1 text-xs font-semibold text-white/75">{desc}</div>
                            </div>
                        ))}
                    </div>
                    <Sparkles className="absolute bottom-6 right-6 size-16 text-white/25" />
                </div>

                <div className="grid gap-4">
                    <section className="rounded-lg border border-orange-200 bg-white p-5 shadow-sm">
                        <div className="flex items-center gap-3">
                            <div className="flex size-10 items-center justify-center rounded-md bg-orange-50 text-orange-600">
                                <UserRound className="size-5" />
                            </div>
                            <div>
                                <div className="text-xs font-semibold text-orange-600">设计师入口</div>
                                <h2 className="text-lg font-black text-stone-950">进入创作工作台</h2>
                            </div>
                        </div>
                        <div className="mt-5 space-y-3">
                            <label className="block text-sm font-bold text-stone-700">设计师账号</label>
                            <Input size="large" value={loginName} onChange={(event) => setLoginName(event.target.value)} placeholder="中文名 / 英文账号 / 邮箱 / 工号" />
                            <label className="block text-sm font-bold text-stone-700">登录密码</label>
                            <Input.Password size="large" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" onPressEnter={submitDesignerLogin} />
                            <Button type="primary" size="large" block loading={submitting} icon={<LogIn className="size-4" />} onClick={submitDesignerLogin}>
                                登录设计师工作台
                            </Button>
                            <Button size="large" block icon={<QrCode className="size-4" />} onClick={loginWithWeCom}>企业微信扫码登录</Button>
                            <div className="rounded-md bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-900">支持中文名、英文账号、邮箱或工号加密码登录。账号由管理员统一创建，首次登录后必须修改初始密码。</div>
                        </div>
                    </section>

                    <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
                        <div className="flex items-center gap-3">
                            <div className="flex size-10 items-center justify-center rounded-md bg-black text-white">
                                <ShieldCheck className="size-5" />
                            </div>
                            <div>
                                <div className="text-xs font-semibold text-stone-500">管理员入口</div>
                                <h2 className="text-lg font-black text-stone-950">进入后台管理</h2>
                            </div>
                        </div>
                        <p className="mt-4 text-sm leading-6 text-stone-500">管理员可以管理设计师账号、额度上限、积分消耗、模型/API、工作流、历史记录和审计日志。</p>
                        <Button className="mt-4" size="large" block onClick={() => navigate("/admin/login")}>
                            打开管理员登录
                        </Button>
                    </section>
                </div>
            </section>
        </main>
    );
}
