import type { PromptInput } from "../../shared/prompt-contracts";
import { PromptOptimizationError } from "./prompt-safety";

export type SceneTemplateOutput = { prompt: string; summaryZh: string; keepText: string[]; questions: string[]; avoid: string[] };
const commonFields = ["description", "instruction", "targetProduct", "keepDetails", "preserve", "carryoverRequirements", "keep_text", "templateId", "branchIndex", "title"];
const sceneFields: Record<string, readonly string[]> = {
  "garment-colorway": ["colorMode", "colors", "colorSelections", "colorRegion", "colorMood", "change", "restyleArea"],
  "pattern-colorway": ["colorMode", "colors", "colorSelections", "colorRegion", "colorMood"],
  "style-to-sketch": ["sketchStyle", "sketchDetail", "views"],
  "local-restyle": ["restyleArea", "change"],
  "pattern-extract": ["extractMode", "extractBackground"],
  "pattern-craft": ["craft", "craftFabric"],
  "series-recipe": ["kind", "series", "constraints", "prompt", "count", "palette", "paletteStyle", "positions", "variantIndex", "branch_index", "hasMotif"],
  "workflow-step": ["step_type", "step_title", "user_text", "previous_step_summary"],
  "print-placement": ["placement", "position", "size", "style"],
  "garment-presentation": ["presentation"],
  "batch-optimize": [],
};
const populated = (value: unknown) => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const normalizedHex = (value: unknown) => {
  if (typeof value !== "string" || !/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value.trim())) return undefined;
  const hex = value.trim().toUpperCase();
  return hex.length === 4 ? `#${[...hex.slice(1)].map(character => character.repeat(2)).join("")}` : hex;
};
const recipeColor = (value: unknown): value is { name: string; hex: string } => record(value)
  && Object.keys(value).every(key => key === "name" || key === "hex")
  && typeof value.name === "string" && value.name.length <= 100 && Boolean(normalizedHex(value.hex));
const canvasTemplateScenes: Record<string, readonly string[]> = {
  development: ["style-to-sketch", "garment-colorway", "garment-presentation"],
  print: ["print-placement", "pattern-craft", "garment-presentation"],
  range: ["garment-colorway", "garment-colorway", "garment-colorway"],
};

/** Deterministic, server-owned visual instructions. Unknown semantics use the short planner, never disappear. */
export function compileSceneTemplate(input: PromptInput, fields: Record<string, unknown>, referenceCount: number, roles: readonly string[], language: "en" | "zh", requiredText: string[]): SceneTemplateOutput | undefined {
  const allowed = sceneFields[input.scene];
  if (!allowed || input.mode === "video") return;
  if (Object.entries(fields).some(([key, value]) => populated(value) && !commonFields.includes(key) && !allowed.includes(key))) return;
  // A whitelist alone is insufficient: every populated field must be rendered or
  // positively identified as current UI metadata before this template may return.
  const consumed = new Set<string>();
  const text = (key: string, fallback = "") => {
    consumed.add(key);
    const value = fields[key];
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || value.length > 20_000) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", `场景字段 ${key} 必须为有效文字，未提交生成。`, 400);
    return value.trim();
  };
  const t = (zh: string, en: string) => language === "zh" ? zh : en;
  const description = text("description");
  const instruction = input.userText.trim() || text("instruction") || description;
  if (["templateId", "branchIndex", "title"].some(key => populated(fields[key]))) {
    // createCanvasDesignTemplate owns this exact triple. The editable title is
    // a node label, not lettering or a replacement for its separate instruction.
    if (typeof fields.templateId !== "string" || !Number.isInteger(fields.branchIndex)
      || canvasTemplateScenes[fields.templateId]?.[Number(fields.branchIndex)] !== input.scene
      || typeof fields.title !== "string" || !fields.title.trim() || fields.title.length > 20_000 || !instruction) return;
    ["templateId", "branchIndex", "title"].forEach(key => consumed.add(key));
  }
  const target = text("targetProduct");
  const targetLabel = target || t(input.scene.startsWith("pattern-") ? "图案" : "服装主体", input.scene.startsWith("pattern-") ? "the artwork" : "the garment");
  let main = "", summaryZh = "";
  let keep = "";
  const details: string[] = [];
  switch (input.scene) {
    case "garment-colorway":
    case "pattern-colorway": {
      const mode = text("colorMode");
      if (mode === "smart") return;
      // These inputs imply extra interpretation. They are never discarded merely
      // because the selected color mode happens to have a deterministic template.
      if (populated(fields.colorMood) || populated(fields.change)) return;
      if (!mode && !instruction) return;
      if (mode && mode !== "specific" && mode !== "reference") throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "配色方式无效，未提交生成。", 400);
      if (mode !== "specific" && (populated(fields.colors) || populated(fields.colorSelections))) return;
      const colorRegion = text("colorRegion"), restyleArea = text("restyleArea");
      if (colorRegion && restyleArea && colorRegion !== restyleArea) return;
      const region = colorRegion || restyleArea || targetLabel;
      let colors = "";
      if (mode === "specific") {
        if (!Array.isArray(fields.colors) || !fields.colors.length || fields.colors.length > 6 || fields.colors.some(value => typeof value !== "string" || !value.trim() || value.length > 100 || /[\r\n]/.test(value) || (value.trim().startsWith("#") && !/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value.trim())))) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "指定配色需要1至6个颜色名称或有效HEX色值，未提交生成。", 400);
        colors = (fields.colors as string[]).join("、");
        consumed.add("colors");
        if (fields.colorSelections !== undefined && fields.colorSelections !== null) {
          if (!Array.isArray(fields.colorSelections) || fields.colorSelections.length !== fields.colors.length) return;
          const selectionKeys = ["id", "name", "hex", "library", "sourceUrl", "source", "datasetVersion"];
          for (const [index, selection] of fields.colorSelections.entries()) {
            if (selection === null) continue;
            // Labels belong to the selected HEX, never to a later manual edit.
            // Source identifiers are provenance, not extra visual instructions.
            if (!record(selection) || Object.keys(selection).some(key => !selectionKeys.includes(key))
              || selectionKeys.some(key => typeof selection[key] !== "string" || (selection[key] as string).length > 2_000)
              || !["id", "name", "library"].every(key => (selection[key] as string).trim())
              || !normalizedHex(selection.hex) || normalizedHex(selection.hex) !== normalizedHex(fields.colors[index])) return;
            details.push(t(`所选色库标签：${selection.library} / ${selection.name}（${fields.colors[index]}）。`, `Selected palette label: ${selection.library} / ${selection.name} (${fields.colors[index]}).`));
          }
          consumed.add("colorSelections");
        }
      }
      if (mode === "reference" && referenceCount < 2) throw new PromptOptimizationError("PROMPT_REFERENCE_REQUIRED", "参考图配色需要第二张配色参考图，未提交生成。", 400);
      main = mode === "reference"
        ? t(`调整图片1中${region}的配色，图片2仅提供颜色，不带入其款式、图案或背景；其他修改按下方明确要求执行。`, `Change the colors of ${region} in Image 1. Image 2 supplies colors only, not its structure, pattern or background. Apply other changes only when explicitly requested below.`)
        : t(`调整图片1中${region}的颜色${colors ? `，使用指定配色：${colors}` : "，按下方原始要求执行"}；其他修改按下方明确要求执行。`, `Change the colors of ${region} in Image 1${colors ? `, using the supplied palette: ${colors}` : ", following the original request below"}. Apply other changes only when explicitly requested below.`);
      keep = t("未明确要求改色的区域保留原颜色；未明确要求调整的结构、数量、位置、纹理与画面内容保持不变。", "Preserve the original colors of areas not explicitly targeted for recoloring. Preserve structure, counts, positions, texture and scene content wherever not explicitly requested to change.");
      summaryZh = mode === "reference" ? "按配色参考图与明确要求调整指定区域，未要求修改的内容保持不变。" : "按明确要求调整指定配色，未要求修改的内容保持不变。";
      break;
    }
    case "style-to-sketch": {
      const style = text("sketchStyle", "technical"), detail = text("sketchDetail", "standard");
      if (!["technical", "minimal"].includes(style) || !["outline", "standard", "detailed"].includes(detail)) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "线稿风格或细节程度无效，未提交生成。", 400);
      // A requested unseen back is a design problem, not an observed extraction.
      if (Array.isArray(fields.views) && fields.views.includes("back")) return;
      if (fields.views !== undefined && (!Array.isArray(fields.views) || fields.views.some(view => view !== "front"))) return;
      if (Array.isArray(fields.views)) {
        consumed.add("views");
        if (fields.views.length) details.push(t("视图要求：正面；仅依据可见参考内容。", "View: front; use only visible reference evidence."));
      }
      main = t(`将图片1中的${targetLabel}转换为${style === "minimal" ? "简洁" : "技术感"}黑白平面款式线稿，白底、黑线、无填色。`, `Convert ${targetLabel} in Image 1 to a ${style === "minimal" ? "minimal" : "technical"} flat fashion drawing, black lines on white, without filled colors.`);
      details.push(t(`细节程度：${detail === "outline" ? "主要轮廓" : detail === "detailed" ? "全部可见细节" : "关键结构"}。`, `Detail: ${detail === "outline" ? "main outlines" : detail === "detailed" ? "all visible details" : "key construction"}.`));
      keep = t("准确保留可见轮廓、纽扣、口袋、接缝的数量与位置，以及真实遮挡；不补画不可见结构。", "Preserve visible outlines and the count and positions of buttons, pockets and seams, including actual occlusion. Do not invent hidden structure.");
      summaryZh = "按参考图可见证据生成线稿，保留部件数量、位置与遮挡。";
      break;
    }
    case "local-restyle": {
      const change = text("change") || instruction;
      if (!change) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "请填写要修改的内容，未提交生成。", 400);
      const area = text("restyleArea", t("明确指定部位", "the specified area"));
      main = t(`只修改图片1中${target ? `${target}的` : ""}${area}：${change}`, `Change only ${area}${target ? ` of ${target}` : ""} in Image 1: ${change}`);
      keep = t("除明确要求的修改外，保持原图表现形式、画面范围、结构、颜色、纹理、图案、背景及拍摄角度不变。", "Except for the explicitly requested changes, preserve the original image's representation and framing, along with structure, colors, texture, pattern, background and camera angle.");
      summaryZh = "只修改明确指定的部位，其余设计与画面保持不变。";
      break;
    }
    case "pattern-extract": {
      const mode = text("extractMode", "单独图案"), background = text("extractBackground", "白底");
      if (!["单独图案", "完整可见花型"].includes(mode) || !["白底", "保留底色"].includes(background)) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "提取范围或背景设置无效，未提交生成。", 400);
      main = t(`从图片1${target ? `的${target}` : ""}提取${mode}，展平为二维图案${background === "白底" ? "，置于纯白不透明背景" : "，保留原底色和真实透明度"}。`, `Extract the ${mode === "单独图案" ? "specified visible pattern content" : "complete visible pattern"} from Image 1${target ? ` (${target})` : ""} as flat 2D artwork${background === "白底" ? " on an opaque white background" : ", preserving the original background color and true transparency"}.`);
      keep = t("保留可见元素的轮廓、数量、相对位置和裁切边界；只处理有证据的内容，不推测遮挡或画外部分。", "Preserve visible contours, element counts, relative positions and crop boundaries. Use visible evidence only, without inventing occluded or off-frame content.");
      summaryZh = "提取可见图案并保留元素关系，不推测缺失内容。";
      break;
    }
    case "pattern-craft": {
      const craft = text("craft");
      if (!craft && !instruction) return;
      main = t(`${referenceCount > 1 ? "按各参考图的明确分工，把指定图案" : "把图片1的图案"}呈现为${craft || "下方指定工艺"}效果${text("craftFabric") ? `，承载面料为${text("craftFabric")}` : ""}。`, `${referenceCount > 1 ? "Following the assigned role of each reference image, render the specified artwork" : "Render the artwork in Image 1"} as ${craft || "the craft specified below"}${text("craftFabric") ? ` on ${text("craftFabric")}` : ""}.`);
      keep = t("保留未明确要求修改的可见元素、颜色、轮廓和数量；未明确允许调整的相对位置保持不变，组合或重排仅限明确指定的范围。主体完整入镜、四边留出背景边距；在指定构图内表现工艺质感。", "Preserve visible elements, colors, contours and counts unless explicitly requested otherwise. Keep relative positions unchanged except within the explicitly allowed scope of composition or rearrangement. Show the complete motif with margins on all sides; express the craft in the specified composition.");
      summaryZh = "按指定工艺呈现完整图案，仅按明确要求调整元素排布。";
      break;
    }
    case "series-recipe": {
      const kind = text("kind");
      if (kind !== "structure" && kind !== "pattern") return;
      // normalizePromptFields selects palette/position before this function. Check
      // the original scheduling fields too, so an invalid branch cannot silently
      // fall back to palette[0] and still claim deterministic correctness.
      const raw = input.fields;
      const index = raw.variantIndex ?? raw.branch_index ?? 0;
      if (!Number.isInteger(index) || Number(index) < 0 || Number(index) > 5
        || (raw.variantIndex !== undefined && raw.branch_index !== undefined && raw.variantIndex !== raw.branch_index)
        || (fields.branch_index !== undefined && fields.branch_index !== index)
        || (raw.count !== undefined && (!Number.isInteger(raw.count) || Number(raw.count) < 1 || Number(raw.count) > 6 || Number(index) >= Number(raw.count)))
        || (raw.series !== undefined && (typeof raw.series !== "string" || raw.series.length > 80))
        || (raw.paletteStyle !== undefined && (typeof raw.paletteStyle !== "string" || !["soft", "vivid", "earth", "free"].includes(raw.paletteStyle)))
        || (raw.hasMotif !== undefined && typeof raw.hasMotif !== "boolean")) return;
      const rawPalette = raw.palette;
      if (Array.isArray(rawPalette)) {
        if (!rawPalette.length || rawPalette.length > 6 || !rawPalette.every(recipeColor) || !rawPalette[Number(index)]
          || JSON.stringify(fields.palette) !== JSON.stringify(rawPalette[Number(index)])) return;
      } else if (!recipeColor(rawPalette)) return;
      const color = fields.palette;
      if (!recipeColor(color)) return;
      if (Array.isArray(raw.positions)) {
        if (raw.positions.length > 6 || raw.positions.some(value => typeof value !== "string" || value.length > 160)
          || (raw.positions.length && (raw.positions[Number(index)] === undefined || fields.positions !== raw.positions[Number(index)]))) return;
      }
      // RecipeForm.series is the saved project name; count/indices schedule one
      // selected candidate. paletteStyle only chooses randomRecipePalette's input;
      // the selected explicit HEX is already frozen. None are printed in the image.
      ["series", "count", "variantIndex", "branch_index", "paletteStyle", "hasMotif", "palette"].forEach(key => consumed.add(key));
      const design = text("prompt");
      if (design && design !== instruction) details.push(design);
      if (kind === "structure") {
        if (fields.hasMotif === true) return;
        // positions is the hidden pattern tab's retained array, not an instruction
        // to add a pattern to a structure-only color branch. Other shapes are unknown.
        if (populated(fields.positions) && !Array.isArray(raw.positions)) return;
        consumed.add("positions");
        main = t(`将图片1的产品主体配色调整为${color.hex}（色板标签：${color.name}），只输出当前配色的单张结果。`, `Recolor the product in Image 1 to ${color.hex} (palette label: ${color.name}). Output one image of the selected color variant.`);
      } else {
        if (fields.hasMotif === true && referenceCount < 2) throw new PromptOptimizationError("PROMPT_REFERENCE_REQUIRED", "图案系列缺少已指定的图案参考图，未提交生成。", 400);
        if (!fields.hasMotif && !instruction && !design) return;
        // The pattern UI always runs one candidate and hides the structure color
        // controls. Recognize that exact form instead of injecting its default HEX.
        if (!Array.isArray(rawPalette) || raw.count !== 1 || index !== 0) return;
        const position = text("positions");
        main = t(`在图片1的产品上${fields.hasMotif === true ? "应用图片2的图案" : "按下方明确要求处理图案"}${position ? `，位置为${position}` : ""}。`, `Apply ${fields.hasMotif === true ? "the motif from Image 2" : "the explicit motif instructions below"} to the product in Image 1${position ? ` at ${position}` : ""}.`);
      }
      keep = text("constraints") || t("未明确要求修改的原款廓形、结构、面料纹理、辅料和背景保持不变。", "Preserve the original silhouette, construction, fabric texture, trims and background wherever not explicitly requested to change.");
      summaryZh = "按当前分支的指定配色或图案生成单张系列结果。";
      break;
    }
    case "workflow-step": {
      if (!instruction && !text("user_text")) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "工作流步骤需要明确的执行要求，未提交生成。", 400);
      const type = text("step_type"), title = text("step_title");
      const types: Record<string, [string, string]> = { white_bg: ["白底图", "white background"], recolor: ["换色", "recolor"], on_model: ["模特上身", "on-model presentation"], detail_shot: ["细节图", "detail view"], scene: ["场景展示", "scene presentation"], custom: ["自定义", "custom"] };
      if (type && !Object.hasOwn(types, type)) return;
      if (type) details.push(t(`步骤类型：${types[type]![0]}。`, `Step type: ${types[type]![1]}.`));
      if (title) details.push(t(`步骤名称：${title}`, `Step label: ${title}`));
      main = t("基于图片1执行本步骤的原始要求。", "Apply this step's original request to Image 1.");
      if (text("previous_step_summary")) details.push(t(`上一步结果（本步骤明确修改优先）：${text("previous_step_summary")}`, `Prior result (explicit changes in this step take precedence): ${text("previous_step_summary")}`));
      if (text("user_text") && !instruction.includes(text("user_text"))) details.push(text("user_text"));
      keep = t("未要求改变的可见设计与画面保持不变。", "Preserve visible design and scene elements not included in the requested changes.");
      summaryZh = "按步骤原话执行，不额外改写或扩展任务。";
      break;
    }
    case "print-placement": {
      if (!instruction) return;
      main = t("基于图片1制作下方指定的印花定位稿。", "Create the requested placed-print artwork using Image 1.");
      for (const key of ["placement", "position", "size", "style"]) if (text(key)) details.push(`${({ placement: "定位", position: "位置", size: "尺寸", style: "风格" } as Record<string, string>)[key]}：${text(key)}`);
      keep = t("保留参考产品的结构与比例，图案位置和大小以明确要求为准。", "Preserve the reference product's construction and proportions; follow the specified motif position and size.");
      summaryZh = "按明确的位置与图案要求制作定位效果，不扩展设计。";
      break;
    }
    case "garment-presentation": {
      if (!instruction) return;
      main = t("按下方要求展示图片1中的服装。", "Present the garment in Image 1 as specified below.");
      if (text("presentation")) details.push(t(`展示方式：${text("presentation")}`, `Presentation: ${text("presentation")}`));
      keep = t("保持服装的款式结构、配色、图案和面料特征。", "Preserve the garment's construction, colors, pattern and fabric characteristics.");
      summaryZh = "按指定方式展示原款，保留产品特征。";
      break;
    }
    case "batch-optimize": {
      if (!instruction) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "请填写批量改图要求，未提交生成。", 400);
      main = t("对每张独立原图分别执行以下修改。", "Apply the following changes to each original image independently.");
      keep = t("各图只使用自身内容，未要求修改的部分保持不变。", "Use each image's own content only, preserving everything outside the requested changes.");
      summaryZh = "将原始修改要求分别用于每张图，不混用图片内容。";
      break;
    }
    default: return;
  }
  if (target && !main.includes(target)) details.unshift(t(`目标对象：${target}`, `Target object: ${target}`));
  const extras = [instruction, description, text("instruction")].filter(value => value && !main.includes(value));
  const uniqueExtras = [...new Set(extras)].filter(value => !extras.some(other => other !== value && other.includes(value)));
  const stringList = (key: string, max: number, itemMax: number) => {
    consumed.add(key);
    const value = fields[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > itemMax)) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", `场景字段 ${key} 必须为有效文字数组，未提交生成。`, 400);
    return value as string[];
  };
  const preserve = [text("keepDetails"), text("preserve"), ...stringList("carryoverRequirements", 12, 800)].filter(Boolean);
  const keepText = [...new Set([...requiredText, ...stringList("keep_text", 50, 1_000)])];
  if (Object.entries(fields).some(([key, value]) => populated(value) && !consumed.has(key))) return;
  const referenceLines = Array.from({ length: referenceCount }, (_, index) => {
    // Roles may already carry this image's heading. Remove only matching leading
    // labels; other image numbers and references inside the description are data.
    const sameImageHeading = new RegExp(`^\\s*(?:(?:图片?|Image)\\s*${index + 1}\\s*[:：]\\s*)+`, "i");
    const role = roles[index]?.replace(sameImageHeading, "") || (index === 0 ? t("要处理的原图", "original to process") : t("仅参考明确指定的内容", "use only for the explicitly specified reference content"));
    return `${language === "zh" ? "图片" : "Image "}${index + 1}：${role}`;
  });
  const prompt = [referenceLines.join("\n"), main, ...details, ...uniqueExtras, keep,
    preserve.length ? `${t("明确保留", "Explicitly preserve")}：${[...new Set(preserve)].join("；")}` : "",
    keepText.length ? `${t("文字原样保留", "Preserve exact lettering")}：${keepText.map(value => JSON.stringify(value)).join("、")}` : "",
  ].filter(Boolean).join("\n");
  return { prompt, summaryZh, keepText, questions: [], avoid: [] };
}
