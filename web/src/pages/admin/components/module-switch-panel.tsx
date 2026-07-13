import { App, Switch } from "antd";
import { useEffect, useState } from "react";

import { moduleKeys, updateModuleFlag, type ModuleKey } from "@/services/api/modules";
import { useModuleStore } from "@/stores/use-module-store";

const moduleDetails: Record<ModuleKey, { label: string; description: string }> = {
    "detail-enhance": { label: "细节增强", description: "控制细节增强工作台和放大类任务提交" },
    "image-edit": { label: "图片编辑", description: "控制图片编辑入口和普通局部编辑任务" },
    "angle-control": { label: "角度控制", description: "控制角度控制入口和对应局部编辑任务" },
    "seamless-stitch": { label: "无缝拼接", description: "控制内部 AI 无缝拼接入口与任务" },
    image: { label: "文生图", description: "控制文生图入口与新图片生成任务" },
    video: { label: "视频创作", description: "控制视频和音频生成入口与任务" },
    prompts: { label: "提示词库", description: "控制设计师端提示词库入口" },
    assets: { label: "素材库", description: "控制设计师端素材库入口；后台存储不受影响" },
    "gpt-chat": { label: "GPT 对话", description: "控制 GPT 对话入口与服务端对话请求" },
    canvas: { label: "无线画布", description: "控制画布入口和画布批量改图任务" },
    team: { label: "我的小组", description: "控制组长端小组看板入口" },
};

export function ModuleSwitchPanel() {
    const { message } = App.useApp();
    const flags = useModuleStore((state) => state.flags);
    const refresh = useModuleStore((state) => state.refresh);
    const setFlag = useModuleStore((state) => state.setFlag);
    const [saving, setSaving] = useState<ModuleKey | null>(null);

    useEffect(() => { void refresh().catch((error) => message.error(error instanceof Error ? error.message : "模块状态读取失败")); }, [message, refresh]);

    const toggle = async (moduleKey: ModuleKey, enabled: boolean) => {
        setSaving(moduleKey);
        try {
            const { module } = await updateModuleFlag(moduleKey, enabled);
            setFlag(module);
            message.success(`${moduleDetails[moduleKey].label}已${enabled ? "开启" : "关闭"}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模块状态更新失败");
        } finally { setSaving(null); }
    };

    return (
        <div className="overflow-hidden rounded-md border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div className="border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                <h2 className="text-base font-semibold">设计师端模块开关</h2>
                <p className="mt-1 text-xs text-stone-500">关闭后入口会隐藏，直达页面和新任务提交也会被拦截；历史、素材数据和后台配置不会删除。</p>
            </div>
            <div className="divide-y divide-stone-100 dark:divide-stone-800">
                {moduleKeys.map((moduleKey) => (
                    <div key={moduleKey} className="flex min-h-16 items-center justify-between gap-4 px-4 py-3">
                        <div className="min-w-0">
                            <div className="text-sm font-medium text-stone-900 dark:text-stone-100">{moduleDetails[moduleKey].label}</div>
                            <div className="mt-1 text-xs text-stone-500">{moduleDetails[moduleKey].description}</div>
                        </div>
                        <Switch checked={flags[moduleKey]} loading={saving === moduleKey} onChange={(enabled) => void toggle(moduleKey, enabled)} aria-label={`${moduleDetails[moduleKey].label}开关`} />
                    </div>
                ))}
            </div>
        </div>
    );
}
