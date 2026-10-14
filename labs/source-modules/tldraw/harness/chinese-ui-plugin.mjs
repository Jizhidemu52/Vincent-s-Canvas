import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Build-time presentation-only overlay. The checked-out upstream tree stays pristine.
// Technical IDs, port IDs, request payload keys and executor control flow are not replaced.
export const uiWords = {
 'Input':'输入','Process':'处理','Output':'输出','Utility':'工具','Nodes':'节点',
 'Generate text':'生成文字','Generate':'生成图像','Load model':'加载模型','Model':'模型',
 'Load image':'加载图片','Image':'图片','Prompt':'提示词','Preview':'预览','Capture':'画布截取',
 'Upscale':'放大','Adjust':'图像调整','Blend':'图像混合','Style transfer':'风格迁移',
 'IP-Adapter':'图像适配器（IP-Adapter）','ControlNet':'结构控制（ControlNet）',
 'Number':'数值','Iterator':'迭代器','Router':'分流器','Concat':'拼接','Prompt concat':'提示词拼接',
 'Provider':'服务商','Reference':'参考图','Ref image':'参考图片','Negative':'负向提示词',
 'not connected':'未连接','connected':'已连接','optional':'可选','no inputs':'暂无输入',
 'Steps':'步数','CFG':'提示词引导（CFG）','Seed':'随机种子','Mode':'模式','Strength':'强度',
 'Scale':'倍率','Method':'方法','Opacity':'不透明度','Brightness':'亮度','Contrast':'对比度','Saturation':'饱和度',
 'Style':'风格图','Content':'内容图','Image A':'图片 A','Image B':'图片 B',
 'Prefix':'前缀','Main':'主体','Suffix':'后缀','Sep':'分隔符','Space':'空格','Newline':'换行','Comma':'逗号','None':'无',
 'Bilinear':'双线性','Lanczos':'兰索斯','AI enhanced':'AI 增强','2x':'2 倍','4x':'4 倍',
 'Normal':'正常','Multiply':'正片叠底','Screen':'滤色','Overlay':'叠加','Difference':'差值',
 'Canny edge':'Canny 边缘','Depth map':'深度图','Pose':'姿态','Segmentation':'语义分割',
 'Fast':'快速','High quality':'高质量','Realistic':'写实','Cinematic':'电影质感','Animated':'动画风格',
 'Stop':'停止','Play from here':'从这里运行','More options':'更多选项','Duplicate':'复制节点',
 'Download image':'下载图片','Copy text':'复制文字','Clear result':'清空结果',
 'Templates':'模板','Template':'模板','Name for selection...':'为选中节点命名…','Save':'保存',
 'Select 2+ nodes and save as a template':'选中至少两个节点后保存为模板','Delete template':'删除模板','Insert node':'插入节点',
 'Run pipeline to generate':'运行流程以生成图像','Run to generate text':'运行以生成文字','No image to preview':'暂无可预览图片',
 'Connect an image to upscale':'请连接需要放大的图片','Connect an image':'请连接图片','Connect images to blend':'请连接需要混合的图片',
 'Connect model + reference image':'请连接模型和参考图片','Connect a reference image':'请连接参考图片','Connect a style image':'请连接风格图片',
 'Run to iterate items':'运行以逐项生成','One item per line...':'每行输入一项…',
 'Replace...':'替换…','Browse...':'选择图片…','Clear image':'清空图片','Drop image here':'将图片拖放到这里','Drop or browse for an image':'拖入图片或点击选择',
 'Generated':'生成结果','Loaded':'已加载图片','Adjusted':'调整结果','Blended':'混合结果','Upscaled':'放大结果',
 'ControlNet result':'结构控制结果','IP-Adapter result':'图像适配结果','Style transfer result':'风格迁移结果','Iterator result':'迭代结果',
 'decrement':'减少','increment':'增加',
 'a photo of a cat sitting on a windowsill':'一只猫坐在窗台上的照片',
};

export function translateSource(code, id) {
 const rel = id.replaceAll('\\','/').split('/templates/image-pipeline/')[1];
 if (rel === 'src/index.css') return code.replace("@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap');", '').replace("font-family: 'Inter', sans-serif;", "font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;");
 if (!rel || !rel.endsWith('.tsx') || /src\/(execution|connection|ports|api)\//.test(rel) || rel.endsWith('nodePorts.tsx')) return code;
 let result = code;
 for (const [en, zh] of Object.entries(uiWords)) {
  // Whole quoted literals and whole JSX text nodes only; no identifier substitution.
  result = result.replaceAll(`'${en}'`, `'${zh}'`).replaceAll(`"${en}"`, `"${zh}"`).replaceAll(`>${en}<`, `>${zh}<`);
 }
 result = result.replace('>Out {i + 1}<', '>输出 {i + 1}<').replace('{node.outputCount} outputs', '{node.outputCount} 个输出');
 result = result.replace("`${items.length} item${items.length !== 1 ? 's' : ''}`", '`${items.length} 项`');
 if (rel === 'src/App.tsx') {
  result = "import { getAssetUrls as getLocalAssetUrls } from '@tldraw/assets/selfHosted.js'\nconst localAssetUrls = getLocalAssetUrls({ baseUrl: '/__lab/assets' })\n" + result;
  result = result.replace(/<Tldraw\r?\n/, '<Tldraw\n\t\t\t\t\tassetUrls={localAssetUrls}\n');
  result = result.replace('persistenceKey="image-pipeline"', 'persistenceKey="original-image-pipeline-lab-zh"');
  result = result.replace('{ isSnapMode: true }', "{ isSnapMode: true, locale: 'zh-cn' }");
 }
 return result;
}

export function chineseUiPlugin() {
 const records = new Map();
 return {
  name: 'isolated-chinese-presentation-overlay', enforce: 'pre',
  transformIndexHtml(html) {
   return html.replace('lang="en"','lang="zh-CN"').replace('<title>tldraw image pipeline</title>', '<title>tldraw 原始图像流程实验室</title>').replace('<link rel="icon" href="/favicon.ico" />', '');
  },
  async transform(code, id) {
   const transformed = translateSource(code, id);
   if (transformed === code) return null;
   records.set(id, { file: id.replaceAll('\\','/').split('/templates/image-pipeline/')[1], before: code, after: transformed });
   const dir = fileURLToPath(new URL('../evidence/', import.meta.url));
   await mkdir(dir, { recursive: true });
   await writeFile(dir + '/chinese-build-transforms.json', JSON.stringify([...records.values()], null, 2));
   return { code: transformed, map: null };
  },
 };
}
