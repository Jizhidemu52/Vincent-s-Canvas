import { generalPromptTemplates } from "../../../../shared/general-prompt-templates";

// Loaded only with the English UI catalog. Stable IDs pair English variants
// with the unchanged Chinese originals; these are built-ins, not user content.
export const englishGeneralPromptVariants: Record<string, { title: string; notes: string; prompt: string }> = {
    "clean-product-background": {
        title: "Product cutout · Clean white background",
        notes: "Upload a product photo. If it contains several products, replace [target product] with its specific location and name.",
        prompt: "[TARGET] Extract [target product] from Image 1 and create a complete product image on a white background.\n\n[CHANGE] Remove people, hands, props, and the original background outside the product. Use an even, pure white background. Keep product edges clean and natural; reconstruct only small occluded edge areas by continuing the adjacent structure.\n\n[LOCK] Preserve the product's overall silhouette, proportions, original colors, material texture, pattern placement, hardware count, and existing text.\n\n[OUTPUT] Show the entire single product, centered with moderate space on every side and a subtle natural shadow.\n\n[EXCLUDE] Do not redesign the product or add decorations, extra logos, or explanatory text.",
    },
    "precise-local-recolor": {
        title: "Local recolor · Change only the specified part",
        notes: "Upload the original image and replace [target part] and [target color].",
        prompt: "[TARGET] Change only the color of [target part] in Image 1 to [target color].\n\n[CHANGE] Fully replace that part's original color, stopping at real seams and object boundaries. Preserve variations in highlights, shadows, and folds under the original lighting.\n\n[LOCK] Leave all other colors unchanged. Preserve the overall shape, proportions, weave, patterns, logos, hardware, placement, and background. Do not modify other objects that share the same color but are outside the target part.\n\n[OUTPUT] Produce a recolored image with the same viewpoint and composition as Image 1.\n\n[EXCLUDE] Do not introduce additional color blocking or spread the target color onto adjacent parts or the background.",
    },
    "remove-one-decoration": {
        title: "Remove a decoration · Restore the original fabric",
        notes: "Upload the original image and clearly specify [decoration location and name].",
        prompt: "[TARGET] Remove [decoration location and name] from Image 1. Edit only this area.\n\n[CHANGE] Remove the decoration and its separate shadow. Naturally extend the surrounding original fabric into the cleared area, maintaining continuity in weave direction, texture scale, base color, and folds.\n\n[LOCK] Preserve the product silhouette, seams, other decorations, patterns, colors, hardware, and original composition.\n\n[OUTPUT] Show the complete edited product, with the repaired area blending into the original fabric.\n\n[EXCLUDE] Do not add a replacement decoration or smooth away textile details across the entire product.",
    },
    "extend-scene-background": {
        title: "Extend the image · Preserve product proportions",
        notes: "Upload the original image, replace [extension direction], and select the desired aspect ratio on the page.",
        prompt: "[TARGET] Extend the background of Image 1 in [extension direction] to add space around the original product.\n\n[CHANGE] Continue the original background's space, ground, colors, texture, and lighting direction into the new area, creating a natural transition.\n\n[LOCK] Do not stretch, resize, or redesign the product. Preserve its silhouette, text, texture, colors, and contact with the original ground.\n\n[OUTPUT] Keep the entire product within the selected aspect ratio, with clean new space suitable for later layout work.\n\n[EXCLUDE] Do not duplicate the product or invent props or headings.",
    },
    "material-transfer": {
        title: "Fabric replacement · Preserve the style",
        notes: "Upload the style as Image 1 and a fabric detail as Image 2. Replace [part to change].",
        prompt: "[TARGET] Use Image 1 as the main style reference. Replace only [part to change] with the fabric appearance from Image 2.\n\n[CHANGE] Image 2 supplies only the fabric color, visible weave, texture scale, and surface sheen, not the product shape or background. Let the new fabric follow the curves, folds, and seams of the target part in Image 1.\n\n[LOCK] Preserve Image 1's construction, neckline, sleeve shape, openings, pockets, button count, and overall proportions. Leave all unspecified parts unchanged.\n\n[FABRIC DETAIL] Reproduce the visible structure and impression of thickness in Image 2, allowing corresponding local reflections and drape to change realistically.\n\n[OUTPUT] Keep Image 1's viewpoint and show one product with the replacement fabric.\n\n[EXCLUDE] Do not mistake photographic shadows or background patterns in Image 2 for fabric motifs.",
    },
    "garment-to-flat-sketch": {
        title: "Garment to line drawing · Front construction",
        notes: "Upload a clear front-view garment image.",
        prompt: "[TARGET] Convert the garment in Image 1 into a front-view flat sketch with black lines on a white background.\n\n[CHANGE] Remove people, the background, photographic shadows, and color. Use clear, continuous lines to show the outer silhouette, neckline, sleeves, placket, pockets, buttons, panel seams, and visible decorations. Use slightly heavier outer contours and finer internal construction lines.\n\n[LOCK] Preserve the visible style proportions, component counts, left-right relationships, and decoration placement in Image 1.\n\n[OUTPUT] Center one complete garment with clean lines and easily readable contours and construction.\n\n[EXCLUDE] Do not invent an unseen back view, internal construction, or dimension labels. Do not add a body or background decoration.",
    },
    "sketch-product-render": {
        title: "Sketch to product rendering · Specified fabric",
        notes: "Upload a garment flat sketch and replace [fabric and color].",
        prompt: "[TARGET] Render the style sketch in Image 1 as a realistic product in [fabric and color].\n\n[CHANGE] Within the construction defined by the sketch, show fabric texture, seams, thickness, natural folds, and soft three-dimensional lighting. Place buttons, zippers, and other parts where the sketch indicates.\n\n[LOCK] Preserve the outer silhouette, body-to-sleeve length proportions, neckline, pockets, openings, and decoration count. Do not add components absent from the sketch.\n\n[OUTPUT] Show one complete product from the front against a clean, light background, emphasizing the style and fabric.\n\n[EXCLUDE] Do not automatically add people, text, watermarks, or extra styling items.",
    },
    "controlled-style-change": {
        title: "Reference redesign · Change only specified details",
        notes: "Upload the original style and replace [specific change], such as changing a round neck to a small V-neck.",
        prompt: "[TARGET] Make one local style change to Image 1: [specific change].\n\n[CHANGE] Apply the new design precisely to the relevant part. Adjust connecting seams, fabric transitions, and local lighting naturally to match the new construction.\n\n[LOCK] Preserve the original body length, sleeves, fit, fabric, colors, pockets, buttons, and decorations wherever they are not involved in the change. Do not let preservation of the original structure cancel the explicitly requested change.\n\n[OUTPUT] Keep Image 1's presentation and composition and produce one complete rendering of the revised style.\n\n[EXCLUDE] Do not also change the theme, add patterns, replace the background, or introduce unrelated accessories.",
    },
    "new-style-from-brief": {
        title: "Text-led design · Single garment proposal",
        notes: "No reference image is required. Replace the category, audience, fit, fabric, color, and design details.",
        prompt: "[TARGET] Design one [garment category] for [audience and occasion], shown as a complete product rendering.\n\n[CHANGE] Use [fit and length], a [neckline type] neckline, and [sleeve type] sleeves. Clearly show [pockets, closure, and decorative details]. Make component positions and counts clear, with a coherent overall design.\n\n[FABRIC DETAIL] Use [fabric appearance] in [color] as the main color. Show the weave, drape, and seams under soft lighting.\n\n[OUTPUT] Show one complete garment from the front, with a simple background, the product occupying the main part of the image, and moderate margins.\n\n[EXCLUDE] Do not add brand logos, prices, explanatory text, or requirements that are not present in the reference images.",
    },
    "pattern-extraction": {
        title: "Extract artwork · Convert to a flat image",
        notes: "Upload a product image containing artwork and replace [artwork location].",
        prompt: "[TARGET] Extract the complete visible artwork from [artwork location] in Image 1 and convert it to a straight-on flat image.\n\n[CHANGE] Remove the product shape, fabric folds, photographic shadows, and perspective distortion to flatten the artwork. Reconnect lines interrupted by minor folds using visible evidence in the original image.\n\n[LOCK] Preserve element counts, distinctive shapes, relative positions, original color areas, line weights, and the artwork's overall width-to-height ratio.\n\n[OUTPUT] Center the complete artwork on a clean background with clear boundaries, suitable for further layout work.\n\n[EXCLUDE] Do not redesign elements, add new decoration, or mix product texture into the artwork. Do not invent new themes for large unseen areas.",
    },
    "pattern-recolor": {
        title: "Pattern recolor · Preserve the arrangement",
        notes: "Upload a flat pattern and replace [element-to-target-color mapping] item by item.",
        prompt: "[TARGET] Change only the colors of the pattern in Image 1, following [element-to-target-color mapping] item by item.\n\n[CHANGE] Assign each target color to its specified background, outline, or element, keeping color boundaries crisp. Even when different elements originally share a color, change them only according to the specified mapping.\n\n[LOCK] Preserve all element counts, sizes, contours, lines, density, directions, spacing, arrangement, and overall proportions.\n\n[OUTPUT] Show the complete flat pattern with the same composition as Image 1, without photographic effects or three-dimensional shadows.\n\n[EXCLUDE] Do not add colors, alter element shapes, or automatically rearrange the pattern.",
    },
    "pattern-motif-variant": {
        title: "Pattern variation · Preserve the overall style",
        notes: "Upload a flat pattern and replace [elements to adjust and specific changes].",
        prompt: "[TARGET] Starting from the flat pattern in Image 1, adjust [elements to adjust and specific changes].\n\n[CHANGE] Express the specified changes in the new elements' contours, details, or orientation. Keep them consistent with the original line language, color-block treatment, and decorative rhythm. Allow adjacent gaps to shift with the new contours for a natural distribution.\n\n[LOCK] Preserve the original palette, overall style, hierarchy of main and supporting motifs, average density, and image proportions. Reuse the original design for elements not specified for change.\n\n[OUTPUT] Produce one complete flat pattern proposal with clear element edges.\n\n[EXCLUDE] Do not introduce unrelated themes, text, photographed fabric texture, or three-dimensional lighting.",
    },
    "print-to-garment": {
        title: "Place a print · Specified position and size",
        notes: "Upload the garment as Image 1 and the artwork as Image 2. Replace [position] and [relative size].",
        prompt: "[TARGET] Use the garment in Image 1 as the main image. Place the artwork from Image 2 at [position] on the garment, at [relative size].\n\n[CHANGE] Image 2 supplies only the artwork. Position its center, orientation, and edges on the fabric as specified. Apply realistic perspective along actual curves and folds so it looks printed onto the fabric.\n\n[LOCK] Preserve the element relationships, colors, and aspect ratio of the artwork in Image 2. Preserve the garment style, fabric, base color, other decorations, pose, and background in Image 1.\n\n[OUTPUT] Show one complete garment rendering with the positioned print.\n\n[EXCLUDE] Do not float the artwork in front of the garment, convert it to embroidery or applique, or spread it into unspecified areas.",
    },
    "embroidery-effect": {
        title: "Flat artwork · Embroidery effect",
        notes: "Upload flat artwork and replace [base fabric appearance] and [thread color palette].",
        prompt: "[TARGET] Present the artwork in Image 1 as embroidery stitched onto [base fabric appearance].\n\n[CHANGE] Use [thread color palette]. Render fine outlines with continuous, compact stitches and wider color areas with fill stitches following each shape. Include realistic thread turns and slight thickness at the edges.\n\n[LOCK] Preserve the artwork's overall proportions, element count, contour relationships, and color regions without rearranging them.\n\n[FABRIC DETAIL] Make the base fabric texture clear but secondary. Let thread highlights follow stitch directions, with shadows showing only a subtle raised surface.\n\n[OUTPUT] Produce a straight-on close-up of the complete artwork so the relationship between stitches and base fabric is easy to inspect.\n\n[EXCLUDE] Do not make it look like a printed sticker, plastic relief, or metal engraving. Do not add new artwork.",
    },
    "jacquard-effect": {
        title: "Flat artwork · Knitted jacquard effect",
        notes: "Upload flat artwork and replace [ground and motif colors].",
        prompt: "[TARGET] Convert the artwork in Image 1 into the visual appearance of knitted jacquard, using [ground and motif colors].\n\n[CHANGE] Form the artwork through the fabric's knitted loops. Give edges subtle loop-based steps. The motif and ground must belong to the same knitted panel, not decoration attached to its surface.\n\n[LOCK] Preserve the main elements' distinctive shapes, count, layout, overall proportions, and color-region mapping.\n\n[FABRIC DETAIL] Keep loop scale consistent and the knit structure continuous. Use soft lighting to convey naturally soft yarn and a flat fabric surface.\n\n[OUTPUT] Show a flat, front-facing knitted fabric rendering with the complete artwork.\n\n[EXCLUDE] Do not convert it to embroidery, printing, or felt applique. Do not invent stitch counts, machine gauges, or production settings.",
    },
    "model-garment-tryon": {
        title: "Model try-on · Separate person and garment references",
        notes: "Upload the model as Image 1 and the target garment as Image 2.",
        prompt: "[TARGET] Use Image 1 as the main person and scene reference. Dress the model in Image 1 in the garment from Image 2.\n\n[CHANGE] Image 2 supplies only the target garment's style, colors, fabric, and decorations. Fit it naturally to the model's pose, with believable relationships at the neckline, cuffs, waist, and hem. Let wearing the garment produce natural folds and occlusion.\n\n[LOCK] Preserve the face, hairstyle, skin tone, pose, composition, and background from Image 1. Preserve the neckline, closure construction, pockets, patterns, and main proportions of the garment from Image 2.\n\n[OUTPUT] Produce a clear garment try-on image with the same composition as Image 1.\n\n[EXCLUDE] Do not transfer Image 2's background, hanger, or other accessories, or change the model's identity.",
    },
    "accessory-wearing": {
        title: "Accessory try-on · Natural scale and contact",
        notes: "Upload the person as Image 1 and the accessory as Image 2. Replace [wearing position and relative size].",
        prompt: "[TARGET] Show the accessory from Image 2 on the person in Image 1 at [wearing position and relative size].\n\n[CHANGE] Image 2 supplies only the accessory's shape, materials, colors, and component relationships. Connect it to the earlobe, neck, hair, or wrist as it would actually be worn. Let hanging parts follow gravity, with plausible occlusion and soft shadows at contact points.\n\n[LOCK] Preserve the accessory structure, stone arrangement, chain links, and main proportions. Preserve the face, skin tone, hairstyle, pose, and background in Image 1.\n\n[OUTPUT] Make the accessory look naturally worn, with its main form complete and clear and its sheen consistent with Image 1's lighting.\n\n[EXCLUDE] Do not add beads or stones, merge chains into skin, or generate duplicate accessories.",
    },
    "product-lifestyle-scene": {
        title: "Lifestyle scene · Change the setting, not the product",
        notes: "Upload a product image and replace [scene description].",
        prompt: "[TARGET] Display the product from Image 1 in [scene description], keeping the product as the main subject.\n\n[CHANGE] Use a background, supporting surface, and a few props that serve the scene. Adjust lighting on the product to match the scene's light source, with consistent ground contact, perspective, scale, and shadows. Props must not hide important product details.\n\n[LOCK] Preserve the product shape, component counts, colors, visible materials, text, and pattern relationships.\n\n[OUTPUT] Create commercial product photography with a clear subject, a layered setting, and coordinated overall colors.\n\n[EXCLUDE] Do not change the style or logos, or paint background decorations onto the product.",
    },
    "fabric-home-mockup": {
        title: "Fabric application · Cushions and home furnishings",
        notes: "Upload the home scene as Image 1 and the fabric as Image 2. Replace [target furnishing].",
        prompt: "[TARGET] Use Image 1 as the main scene. Replace only the surface fabric of [target furnishing], using Image 2 as the fabric reference.\n\n[CHANGE] Image 2 supplies the colors, weave, and pattern. Fit the fabric along the target object's curves, seams, piping, and folds, with consistent pattern scale, plausible perspective, and correct occlusion.\n\n[LOCK] Preserve the object's shape, position, volume, ambient lighting, and all other furniture in Image 1. Preserve the main pattern and color relationships in Image 2.\n\n[OUTPUT] Produce a natural home-furnishing fabric mockup with the target object clearly visible.\n\n[EXCLUDE] Do not spread the new fabric onto walls, floors, or unspecified furniture. Do not add new objects.",
    },
    "coordinated-accessory-set": {
        title: "Coordinated collection · One design language",
        notes: "Replace [category list], [theme], [palette], and [material characteristics].",
        prompt: "[TARGET] Develop a set of [category list] around [theme], creating a coordinated collection that is unified but not repetitive.\n\n[CHANGE] Share [palette], [material characteristics], and one core decorative language across the set. Adapt decoration scale, placement, and function to each category's construction instead of mechanically copying one motif to make every item look identical.\n\n[LOCK] Keep color relationships, material appearance, and the core theme consistent, with each product's construction clear and recognizable.\n\n[OUTPUT] Show every item separately against a simple background, with sensible relative sizes and no overlap, like a complete design proposal.\n\n[EXCLUDE] Do not add categories outside the list, brand names, prices, or explanatory text.",
    },
    "product-banner-layout": {
        title: "Product banner · Leave space for copy",
        notes: "Upload a product image and replace [product position] and [background style].",
        prompt: "[TARGET] Create a horizontal promotional image using the product from Image 1. Place it at [product position] against [background style].\n\n[CHANGE] Keep the product as the visual focus. Use environmental colors, soft lighting, and a simple composition to create the display atmosphere. Leave an uninterrupted, clean area for copy on the opposite side of the product.\n\n[LOCK] Preserve the product silhouette, proportions, colors, materials, original text, and decoration count.\n\n[OUTPUT] Create a horizontal commercial visual with the entire product visible and clear negative space for later layout work.\n\n[EXCLUDE] Do not automatically generate headings, slogans, prices, or watermarks. Do not let props hide the product.",
    },
    "video-product-subtle-motion": {
        title: "5-second video · Subtle product movement",
        notes: "Upload a product image as the first frame and select a 5-second duration. Suitable for knitwear, scarves, bags, and similar products.",
        prompt: "Use Image 1 as the first frame to create a simple 5-second product showcase video. 0-2 seconds: keep the complete product composition and a steady camera, allowing only very small natural movements in soft parts. 2-5 seconds: slowly move the camera closer to the main product so surface texture and local sheen become clearer. Continue the first frame's background, colors, and light direction. Keep the product style, colors, patterns, text, hardware count, and overall proportions consistent throughout; rigid parts remain stable. Do not add people, hands, subtitles, watermarks, or new logos.",
    },
    "video-model-garment": {
        title: "5-second video · Model turning showcase",
        notes: "Upload a model wearing the garment as the first frame and select a 5-second duration.",
        prompt: "Use Image 1 as the first frame to create a 5-second fashion-model showcase video. 0-2 seconds: the model stands naturally, with subtle natural movement in the shoulders and garment hem and a calm gaze. 2-5 seconds: the model slowly turns toward their own left into a slight side view to show the garment's side silhouette, while the camera remains steady and gently moves closer. Let garment folds change naturally with the turn, keeping the subject in frame throughout. Preserve the face, hairstyle, garment style, colors, patterns, and original lighting. Do not add action props, subtitles, watermarks, or new logos.",
    },
    "video-texture-closeup": {
        title: "5-second video · Material detail close-up",
        notes: "Upload a material or construction detail image as the first frame and select a 5-second duration.",
        prompt: "Use Image 1 as the first frame to create a 5-second material-detail video. 0-2 seconds: retain the original detail composition and focus, with soft side lighting revealing the surface texture. 2-5 seconds: slowly move the camera a short distance sideways along the surface, maintaining a similar shooting distance and continuous sharpness as more detail is revealed. Only the camera and natural reflections change subtly. The material must not deform or melt; keep the count and relationships of knitted loops, embroidery threads, or metal components stable. Continue the first frame's colors. Do not add text, watermarks, people, or extra decorations.",
    },
};

const labels: Record<string, string> = {
    "通用提示词": "General prompts",
    "公共提示词": "Public prompts",
    "个通用模板": "general templates",
    "选择通用起点，或复用团队与公共模板。先填入、再调整；团队模板经过审核，公共模板由管理员维护。": "Choose a general starting point or reuse a team or public template. Fill it in, then adjust it. Team templates are reviewed; public templates are maintained by administrators.",
    "按公开资料整理的通用起点。替换方括号内的内容后再使用；填入只替换提示词，保留目标页面已有参数和参考图，不会自动生成。": "General starting points based on public guidance. Replace the text in square brackets before use. Filling in a prompt preserves the destination's existing settings and reference images and does not generate automatically.",
    "已存到我的提示词": "Saved to my prompts",
    "存到我的提示词": "Save to my prompts",
    "参考来源": "Sources",
    "通用模板不是生成记录，也不代表已逐项实测。查看、复制和填入不会提交生成任务。": "General templates are not generation records and have not necessarily been individually tested. Viewing, copying, or filling them in does not submit a generation task.",
    "模板加载失败，请重试": "Could not load the template. Try again.",
    "正在读取模板…": "Loading template…",
    "正在处理，请稍候": "Processing, please wait",
    "查看详情不会提交生成；填入后可继续调整。": "Viewing details does not submit a generation task. You can keep editing after filling in the template.",
    "商品处理": "Product editing", "服装与配饰": "Fashion and accessories", "图案与工艺": "Artwork and techniques", "场景与展示": "Scenes and presentation", "视频动效": "Video and motion",
    "白底": "White background", "产品提取": "Product cutout", "电商": "E-commerce", "改色": "Recolor", "局部": "Local", "保留结构": "Preserve construction", "删除": "Remove", "局部修改": "Local editing", "面料修补": "Fabric repair", "扩图": "Outpainting", "背景": "Background", "横幅": "Banner",
    "换面料": "Fabric replacement", "双图参考": "Two-image reference", "材质": "Material", "线稿": "Line drawing", "款式图": "Flat sketch", "结构": "Construction", "线稿渲染": "Sketch rendering", "面料": "Fabric", "效果图": "Rendering", "改款": "Style variation", "设计开发": "Design development", "文字生图": "Text to image", "服装开发": "Garment development", "新品": "New product",
    "提取图案": "Artwork extraction", "印花": "Print", "平面稿": "Flat artwork", "花型": "Pattern", "配色": "Color palette", "色块": "Color areas", "花型变体": "Pattern variation", "元素开发": "Motif development", "设计": "Design", "图案定位": "Artwork placement", "印花效果": "Print mockup", "双图": "Two images", "刺绣": "Embroidery", "工艺效果": "Technique mockup", "针迹": "Stitches", "提花": "Jacquard", "针织": "Knit", "纹理": "Texture",
    "模特": "Model", "换装": "Try-on", "饰品": "Accessories", "佩戴": "Wearing", "首饰": "Jewelry", "场景": "Scene", "产品摄影": "Product photography", "氛围": "Atmosphere", "家居": "Home furnishings", "抱枕": "Cushion", "系列": "Collection", "配套": "Coordinated set", "封面": "Cover", "电商海报": "E-commerce poster", "图生视频": "Image to video", "商品展示": "Product showcase", "5秒": "5 seconds", "转身": "Turning", "服装视频": "Fashion video", "特写": "Close-up", "细节": "Details",
    "BFL：明确修改对象、变化与保留项": "BFL: Specify the target, changes, and what to preserve",
    "BFL：多图分工与位置关系": "BFL: Multiple reference roles and spatial relationships",
    "BFL：服装与配饰编辑场景": "BFL: Clothing and accessory editing use cases",
    "Adobe：主体、画面特征与光线描述": "Adobe: Describe the subject, visual characteristics, and lighting",
    "Adobe：视频动作、镜头与节奏描述": "Adobe: Describe video movement, camera work, and pacing",
};

export default {
    ...labels,
    ...Object.fromEntries(generalPromptTemplates.flatMap(item => {
        const variant = englishGeneralPromptVariants[item.id];
        return variant ? [[item.title, variant.title], [item.notes, variant.notes], [item.prompt, variant.prompt]] : [];
    })),
} satisfies Record<string, string>;
