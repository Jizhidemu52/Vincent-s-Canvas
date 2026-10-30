import { formatBeijingDateTime } from "@/lib/beijing-time";

const labels: Record<string, string> = {
    active: "启用", disabled: "停用", locked: "锁定", archived: "已归档", deleted: "已删除",
    success: "成功", succeeded: "成功", failed: "失败", denied: "已拒绝", pending: "待处理", cancelled: "已取消", processing: "处理中", completed: "已完成", queued: "排队中", waiting: "等待中", paused: "已暂停",
    draft: "草稿", testing: "测试中", published: "已发布", retired: "已停用",
    image: "图片", video: "视频", audio: "音频", generation: "生成结果", "task-reference": "任务参考图", upload: "手动上传", canvas: "画布", clipboard: "剪贴板",
    generate: "图像生成", edit: "图像编辑", batch: "批量处理", chat: "对话", upscale: "图片放大", remove_background: "去背景", inpaint: "局部编辑", image_generation: "图像生成", video_generation: "视频生成", audio_generation: "音频生成", batch_image: "批量图片", seamless_stitch: "无缝拼接",
    "account.create": "创建账号", "account.update": "更新账号", "account.disable": "停用账号", "account.reset_password": "重置密码", "account.credits.adjust": "调整积分", "account.credits.set": "设置积分", "credits.adjust": "调整积分", "credits.set": "设置积分", "department.create": "创建部门", "module.update": "更新模块开关", "credit_policy.update": "更新计费策略", "price.publish": "发布价格", "task.cancel": "取消任务", "asset.adopted": "采用素材", "asset.delivered": "交付素材", "asset.pending": "素材待定", "asset.rejected": "废弃素材",
    amount: "积分变化", balance: "当前余额", reason: "原因", credits: "积分", creditBalance: "积分余额", monthlyCreditLimit: "每月固定额度", status: "状态", enabled: "启用状态", displayName: "姓名", role: "角色", designer: "设计师", super_admin: "超级管理员", department_admin: "部门管理员", username: "账号", departmentId: "部门编号", modelId: "模型编号", modelName: "模型", operationType: "操作", width: "宽度", height: "高度", size: "尺寸", resolution: "分辨率", quality: "质量", count: "数量", n: "数量", seed: "随机种子", duration: "时长", prompt: "提示词", negativePrompt: "反向提示词", aspectRatio: "比例", rmbCost: "人民币成本", targetId: "目标编号", previous: "修改前", before: "修改前", after: "修改后", input: "输入", output: "输出", configurationVersion: "配置版本", requestId: "请求编号", userId: "成员编号", scope: "范围", temporary: "本月临时调整", permanent: "固定额度", createdAt: "创建时间", updatedAt: "更新时间",
};

const auditTargets: Record<string, string> = { account: "账号", department: "部门", group: "小组", task: "任务", batch: "批次", price: "价格", pricing: "价格", model: "模型", provider: "API 服务", workflow: "工作流", module: "模块", credits: "积分", tool: "板块", tool_config: "板块配置", prompt: "提示词", prompt_recipe: "提示词配方", team: "小组", asset: "素材", usage: "用量统计", featured_models: "热门模型" };
const auditActions: Record<string, string> = { created: "创建", updated: "更新", deleted: "删除", enabled: "启用", disabled: "停用", password_reset: "重置密码", bulk_created: "批量创建", adjusted: "调整", balance_set: "设置余额", published: "发布", testing: "进入测试", availability_changed: "调整可用性", policy_changed: "调整计费策略", member_removed: "移除成员", history_exported: "导出历史", paused: "暂停", resumed: "恢复", cancelled: "取消", admin_paused: "管理员暂停", admin_resumed: "管理员恢复", admin_cancelled: "管理员取消", activated: "激活", archived: "归档", exported: "导出", viewed: "查看", team_submitted: "提交小组审核", team_approved: "小组审核通过", team_rejected: "小组审核拒绝", public_published: "发布公共库", personal_created: "创建个人模板", personal_updated: "更新个人模板", personal_deleted: "删除个人模板", copied: "复制", reused: "复用" };
export function adminLabel(value: string | null | undefined) {
    if (!value) return "—";
    if (labels[value]) return labels[value];
    const [target, action] = value.split(".");
    return auditTargets[target] && auditActions[action] ? `${auditTargets[target]}：${auditActions[action]}` : value;
}

export function AdminDetails({ value }: { value: unknown }) {
    if (value == null || value === "") return <span>—</span>;
    if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
    if (Array.isArray(value)) return value.length ? <ul className="space-y-1">{value.map((item, index) => <li key={index}><AdminDetails value={item} /></li>)}</ul> : <span>无</span>;
    if (typeof value === "object") return <dl className="grid min-w-0 grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">{Object.entries(value).map(([key, item]) => <div className="contents" key={key}><dt className="text-[var(--muted-foreground)]">{adminLabel(key)}</dt><dd className="break-words">{/(?:At|Time)$/.test(key) && typeof item === "string" && /^\d{4}-\d{2}-\d{2}T/.test(item) ? `${formatBeijingDateTime(item)}（北京时间）` : <AdminDetails value={item} />}</dd></div>)}</dl>;
    return <span className="whitespace-pre-wrap break-words">{typeof value === "string" ? adminLabel(value) : String(value)}</span>;
}
