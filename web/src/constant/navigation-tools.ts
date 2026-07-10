import { Box, FileText, Grid2x2, ImageIcon, ImagePlus, Images, MessageSquare, ShieldCheck, Sparkles, Video, Zap } from "lucide-react";

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
        slug: "assets",
        path: "/assets",
        label: "素材库",
        icon: Images,
        group: "local",
    },
    {
        slug: "gpt-chat",
        path: "/canvas?tool=gpt-chat",
        label: "GPT 对话",
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
        slug: "admin",
        path: "/admin",
        label: "后台管理",
        icon: ShieldCheck,
        group: "admin",
    },
] as const;

export type NavigationGroup = (typeof navigationTools)[number]["group"];
export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

export const navigationToolBilling: Partial<Record<NavigationToolSlug, { operationType: AdminOperationType; modelId?: string }>> = {
    image: { operationType: "image_generation", modelId: "gpt-image-2" },
    "detail-enhance": { operationType: "upscale", modelId: "gpt-image-2" },
    "image-edit": { operationType: "inpaint", modelId: "gpt-image-2" },
    "angle-control": { operationType: "inpaint", modelId: "gpt-image-2" },
    "seamless-stitch": { operationType: "seamless_stitch", modelId: "internal-seamless" },
    video: { operationType: "video_generation" },
};
