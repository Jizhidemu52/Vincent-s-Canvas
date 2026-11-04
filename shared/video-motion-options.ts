/** Public option vocabulary only. Prompt authoring rules live in the server database. */
export type VideoMotionSettings = {
  purpose: string; subject_action: string[]; camera: string; shot_scale: string;
  pace: string; lighting: string; style: string; audio: string; keep: string[];
};
type MotionOption = { id: string; label: string; description: string };
type MotionGroup = { id: keyof VideoMotionSettings; label: string; multiple?: boolean; max?: number; options: MotionOption[] };
const option = (id: string, label: string, description: string): MotionOption => ({ id, label, description });
export const videoMotionGroups: MotionGroup[] = [
  { id: "purpose", label: "视频用途", options: [option("ecommerce", "电商展示", "清楚展示产品"), option("model", "模特展示", "展示穿戴效果"), option("detail", "细节特写", "突出材质与工艺"), option("360", "360°展示", "多角度展示产品"), option("atmosphere", "氛围短片", "强调场景与情绪")] },
  { id: "subject_action", label: "主体动作", multiple: true, max: 2, options: [option("subtle", "自然微动", "轻微自然的动作"), option("turn", "转身展示", "转身展示侧面与背面"), option("walk", "走向镜头", "向镜头方向移动"), option("adjust", "整理衣服", "自然整理穿着"), option("touch", "抚摸面料", "用手展示面料触感"), option("hair", "撩发回眸", "轻拨头发并回望"), option("hand", "手部展示饰品", "用手呈现饰品细节"), option("rotate", "饰品旋转", "缓慢转动饰品"), option("breeze", "衣服随风轻摆", "衣料随微风摆动")] },
  { id: "camera", label: "镜头运动", options: [option("auto", "AI决定", "根据图片选择"), option("fixed", "固定镜头", "保持相机位置"), option("push", "缓慢推近", "逐渐靠近主体"), option("pull", "缓慢拉远", "逐渐展开画面"), option("orbit", "环绕", "围绕主体移动"), option("pan", "横移", "沿水平方向移动"), option("follow", "跟随", "跟随主体移动"), option("tilt", "俯拍下摇", "从上方向下展示")] },
  { id: "shot_scale", label: "景别", options: [option("auto", "AI决定", "根据图片选择"), option("full", "全身", "展示完整主体"), option("medium", "半身", "展示上半身"), option("close", "近景", "靠近主要细节"), option("macro", "特写/微距", "突出局部纹理")] },
  { id: "pace", label: "节奏", options: [option("slow", "舒缓", "缓慢从容"), option("natural", "自然", "正常动作节奏"), option("light", "轻快", "轻盈利落"), option("dynamic", "动感", "明快有活力")] },
  { id: "lighting", label: "光线氛围", options: [option("original", "保持原图", "延续原有光线"), option("soft", "柔和自然光", "柔和明亮"), option("studio", "棚拍质感", "干净的摄影棚光线"), option("warm", "暖调午后", "温暖的午后色调"), option("cool", "清冷高级", "克制的冷色氛围"), option("neon", "夜景霓虹", "夜晚彩色光线")] },
  { id: "style", label: "风格", options: [option("commercial", "商业广告", "突出产品卖点"), option("fashion", "时尚大片", "强调造型与视觉感"), option("daily", "生活记录", "自然日常感"), option("cinematic", "电影感", "注重画面叙事")] },
  { id: "audio", label: "声音", options: [option("none", "无声", "关闭声音输出"), option("ambient", "仅环境音", "保留环境与动作声音"), option("music", "环境音+轻音乐", "加入轻音乐氛围")] },
  { id: "keep", label: "必须保持", multiple: true, options: [option("shape", "款式", "保持产品结构"), option("color", "颜色", "保持产品颜色"), option("pattern", "图案/Logo", "保持原有图案与品牌标识"), option("face", "人物长相", "保持人物外貌"), option("background", "背景", "保持原有环境")] },
];
export const defaultVideoMotionSettings: VideoMotionSettings = {
  purpose: "auto", subject_action: [], camera: "auto", shot_scale: "auto", pace: "auto",
  lighting: "auto", style: "auto", audio: "none", keep: ["shape", "color", "pattern", "face"],
};
export function normalizeVideoMotionSettings(input: unknown): VideoMotionSettings {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const result = structuredClone(defaultVideoMotionSettings);
  for (const group of videoMotionGroups) {
    const valid = new Set(group.options.map(item => item.id));
    if (group.multiple) {
      if (Array.isArray(source[group.id])) (result[group.id] as string[]) = [...new Set((source[group.id] as unknown[]).filter((item): item is string => typeof item === "string" && valid.has(item)))].slice(0, group.max ?? valid.size);
    } else if (typeof source[group.id] === "string" && (valid.has(source[group.id] as string) || (source[group.id] === "auto" && group.id !== "audio"))) {
      (result[group.id] as string) = source[group.id] as string;
    }
  }
  return result;
}
/** Translate public IDs for the private compiler without embedding authoring instructions. */
export function videoMotionLabels(input: unknown): Record<string, string | string[]> {
  const settings = normalizeVideoMotionSettings(input);
  return Object.fromEntries(videoMotionGroups.map(group => {
    const label = (id: string) => group.options.find(item => item.id === id)?.label ?? "auto";
    const value = settings[group.id];
    return [group.id, Array.isArray(value) ? value.map(label) : label(value)];
  }));
}
