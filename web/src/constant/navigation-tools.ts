import { BookMarked, Box, FileText, Grid2x2, ImageIcon, ImagePlus, Images, MessageSquare, ShieldCheck, Sparkles, UserRoundCog, Video, Zap } from "lucide-react";

import type { AdminOperationType } from "@/lib/admin-domain";

export const navigationTools = [
    {
        slug: "detail-enhance",
        path: "/image?tool=detail-enhance",
        label: "细节增强",
        icon: Zap,
        group: "local",
    },
    {
        slug: "image-edit",
        path: "/image?tool=image-edit",
        label: "图片编辑",
        icon: ImagePlus,
        group: "local",
    },
    {
        slug: "angle-control",
        path: "/image?tool=angle-control",
        label: "角度控制",
        icon: Sparkles,
        group: "local",
    },
    {
        slug: "seamless-stitch",
        path: "/image?tool=seamless-stitch",
        label: "无缝拼接",
        icon: Grid2x2,
        group: "local",
    },
    {
        slug: "image",
        path: "/image",
        label: "文生图",
        icon: ImageIcon,
        group: "local",
    },
    {
        slug: "video",
        path: "/video",
        label: "视频创作",
        icon: Video,
        group: "local",
    },
    {
        slug: "prompts",
        path: "/prompts",
        label: "提示词库",
        icon: FileText,
        group: "local",
    },
    {
        slug: "my-prompts",
        path: "/my-prompts",
        label: "我的提示词",
        icon: BookMarked,
        group: "local",
    },
    {
        slug: "assets",
        path: "/assets",
        label: "素材库",
        icon: Images,
        group: "local",
    },
    {
        slug: "gpt-chat",
        path: "/chat",
        label: "LLM 对话",
        icon: MessageSquare,
        group: "online",
    },
    {
        slug: "canvas",
        path: "/canvas",
        label: "无线画布",
        icon: Box,
        group: "online",
    },
    {
        slug: "team",
        path: "/team",
        label: "我的小组",
        icon: UserRoundCog,
        group: "admin",
    },
    {
        slug: "admin",
        path: "/admin",
        label: "后台管理",
        icon: ShieldCheck,
        group: "admin",
    },
] as const;

export type NavigationGroup = (typeof navigationTools)[number]["group"];
export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

export function navigationModuleKey(slug: NavigationToolSlug) {
    return slug === "my-prompts" ? "prompts" : slug;
}

export const navigationToolBilling: Partial<Record<NavigationToolSlug, { operationType: AdminOperationType; toolKey: string }>> = {
    image: { operationType: "image_generation", toolKey: "image" },
    "detail-enhance": { operationType: "upscale", toolKey: "detail-enhance" },
    "image-edit": { operationType: "inpaint", toolKey: "image-edit" },
    "angle-control": { operationType: "inpaint", toolKey: "angle-control" },
    "seamless-stitch": { operationType: "seamless_stitch", toolKey: "seamless-stitch" },
    video: { operationType: "video_generation", toolKey: "video" },
};
