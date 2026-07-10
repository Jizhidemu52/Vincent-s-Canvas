import { App, Button, Form, Input } from "antd";
import { LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { changeOwnPassword, getCurrentSession } from "@/services/api/auth";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

type Values = { currentPassword: string; newPassword: string; confirmPassword: string };

export default function ChangePasswordPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [submitting, setSubmitting] = useState(false);
    const updateUser = useUserStore((state) => state.updateUser);

    const submit = async (values: Values) => {
        if (values.newPassword !== values.confirmPassword) { message.error("两次输入的新密码不一致"); return; }
        setSubmitting(true);
        try {
            await changeOwnPassword(values.currentPassword, values.newPassword);
            const { user } = await getCurrentSession();
            updateUser(user);
            message.success("密码已更新");
            navigate(isAdminRole(user.role) ? "/admin" : "/", { replace: true });
        } catch (error) { message.error(error instanceof Error ? error.message : "密码修改失败"); }
        finally { setSubmitting(false); }
    };

    return (
        <main className="flex h-full items-center justify-center bg-[#eeeeec] px-5 py-8 text-stone-950">
            <section className="w-full max-w-md rounded-lg border border-orange-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-3"><div className="flex size-10 items-center justify-center rounded-md bg-orange-600 text-white"><LockKeyhole className="size-5" /></div><div><div className="text-xs font-semibold text-orange-600">账号安全</div><h1 className="text-xl font-black">首次登录请修改密码</h1></div></div>
                <p className="mt-4 text-sm leading-6 text-stone-500">新密码至少 12 位，并同时包含字母和数字。修改后其他登录会话将自动退出。</p>
                <Form<Values> className="mt-5" layout="vertical" onFinish={submit}>
                    <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
                    <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 12, message: "密码至少需要 12 位" }]}><Input.Password autoComplete="new-password" /></Form.Item>
                    <Form.Item name="confirmPassword" label="再次输入新密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
                    <Button type="primary" htmlType="submit" loading={submitting} block>修改密码并继续</Button>
                </Form>
            </section>
        </main>
    );
}
