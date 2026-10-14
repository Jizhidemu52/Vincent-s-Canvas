// Harness only: every implementation under test is imported from the pristine InvokeAI checkout.
import { createDomRasterBackend } from '/upstream/invoke/workbench/canvas-engine/render/raster.ts';
import { createSelectionState } from '/upstream/invoke/workbench/canvas-engine/selection/selectionState.ts';
import { PreviewStateController } from '/upstream/invoke/workbench/canvas-engine/controllers/previewStateController.ts';
import { withMatchingCanvasProject, getCanvasGallerySaveErrorAction } from '/upstream/invoke/workbench/widgets/canvas/canvasGallerySaveState.ts';

const checks=[];
function equal(actual,expected,message='values differ') {
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`${message}; expected=${JSON.stringify(expected)}; actual=${JSON.stringify(actual)}`);
}
function ok(value,message='condition is false') { if(!value)throw new Error(message); }
async function check(id,name,fn) {
  const start=performance.now();
  try { const evidence=await fn();checks.push({id,name,status:'passed',duration_ms:+(performance.now()-start).toFixed(2),evidence:evidence??null}); }
  catch(error){checks.push({id,name,status:'failed',duration_ms:+(performance.now()-start).toFixed(2),error:error.message,stack:error.stack});}
}
function harness(options={}) {
  const backend=createDomRasterBackend();let notifications=0;
  const selection=createSelectionState({backend,createPath2D:options.createPath2D||((data)=>new Path2D(data)),getDocumentSize:()=>({width:100,height:100}),onChange:()=>notifications++});
  return {backend,selection,notifications:()=>notifications};
}
function rect(x,y,width,height){return {x,y,width,height};}
function commit(selection,x,y,width,height,op){const path=new Path2D();path.rect(x,y,width,height);selection.commit({path,bounds:rect(x,y,width,height),op});}
function alpha(selection){const mask=selection.mask();return mask?[...mask.surface.ctx.getImageData(0,0,mask.surface.width,mask.surface.height).data].filter((_,i)=>i%4===3):[];}
function coverage(selection){return alpha(selection).filter(value=>value>0).length;}
function sourceMask(backend,values,width,height){const surface=backend.createSurface(width,height),pixels=surface.ctx.createImageData(width,height);values.forEach((a,i)=>pixels.data.set([255,255,255,a],i*4));surface.ctx.putImageData(pixels,0,0);return surface;}

await check('I01','真实像素：导入半透明选区与源图隔离',()=>{
  const h=harness();const source=sourceMask(h.backend,[0,64,255,0],2,2);
  h.selection.replaceMask({rect:rect(7,-3,2,2),surface:source});source.ctx.clearRect(0,0,2,2);
  equal(alpha(h.selection),[0,64,255,0]);equal(h.selection.bounds(),rect(7,-3,2,2));
  equal(h.selection.containsPoint({x:8,y:-3}),true);equal(h.selection.containsPoint({x:7,y:-3}),false);
  return {alpha:alpha(h.selection),documentBounds:h.selection.bounds(),backend:h.selection.mask().surface.canvas.constructor.name};
});
await check('I02','真实像素：选区相加、相减、相交',()=>{
  const {selection}=harness();commit(selection,0,0,4,4,'replace');equal(coverage(selection),16);
  commit(selection,4,0,4,4,'add');equal(coverage(selection),32);
  commit(selection,2,0,2,4,'subtract');equal(coverage(selection),24);equal(selection.containsPoint({x:2,y:1}),false);
  commit(selection,4,0,4,2,'intersect');equal(coverage(selection),8);equal(selection.containsPoint({x:7,y:1}),true);equal(selection.containsPoint({x:7,y:3}),false);
  return {coverageAfterIntersect:coverage(selection),bounds:selection.bounds()};
});
await check('I03','选区快照恢复，后续编辑不污染历史快照',()=>{
  const {selection}=harness();commit(selection,-4,7,3,2,'replace');const captured=selection.snapshot(),before=[...captured.alpha];
  commit(selection,12,12,4,4,'add');equal([...captured.alpha],before);equal(captured.bounds,rect(-4,7,3,2));
  selection.clear();selection.restore(captured);equal(alpha(selection),before);equal(selection.bounds(),rect(-4,7,3,2));equal(coverage(selection),6);
  return {restoredCoverage:coverage(selection),snapshotDetached:true,persistence:'in-memory snapshot only; Path2D commits are not JSON persistence'};
});
await check('I04','替换选区失败的原子性：Path2D 构建异常保留原状态',()=>{
  let fail=false;const h=harness({createPath2D:data=>{if(fail)throw new Error('injected Path2D allocation failure');return new Path2D(data);}});
  h.selection.selectAll(rect(1,2,3,4));const before=alpha(h.selection),bounds=h.selection.bounds(),notifies=h.notifications();
  const source=sourceMask(h.backend,[255,255,255,255],2,2);fail=true;let caught=false;
  try{h.selection.replaceMask({rect:rect(10,20,2,2),surface:source});}catch(error){caught=/injected/.test(error.message);}
  ok(caught);equal(alpha(h.selection),before);equal(h.selection.bounds(),bounds);equal(h.notifications(),notifies);
  return {injectedBoundary:'createPath2D throws once',oldPixelsRetained:before.length,notificationsBefore:notifies,notificationsAfter:h.notifications()};
});
await check('I05','候选异步串图保护：旧 token 和清空后的结果不得发布',()=>{
  const controller=new PreviewStateController(),surface=createDomRasterBackend().createSurface(2,2);
  const older=controller.nextStagedToken(),newer=controller.nextStagedToken();
  equal(controller.publishStaged(older,{surface,width:2,height:2}),false);
  equal(controller.publishStaged(newer,{surface,width:2,height:2}),true);
  equal(controller.clearStaged(),true);equal(controller.publishStaged(newer,{surface,width:2,height:2}),false);equal(controller.getStaged(),null);
  return {older,newer,lateResultRejected:true};
});
await check('I06','滤镜预览逐图层隔离，清空使进行中的 token 失效',()=>{
  const controller=new PreviewStateController(),surface=createDomRasterBackend().createSurface(1,1),preview={surface,rect:rect(0,0,1,1),guard:{}};
  const collar=controller.beginGuardedFilter('collar'),sleeve=controller.beginGuardedFilter('sleeve');
  equal(controller.publishFilter('collar',collar,preview),true);equal(controller.publishFilter('sleeve',sleeve,preview),true);
  const snapshot=controller.filterSnapshot();snapshot.delete('collar');equal(controller.hasFilter('collar'),true);
  controller.clearFilter('collar');equal(controller.hasFilter('sleeve'),true);equal(controller.publishFilter('collar',collar,preview),false);
  controller.clearFilters();equal(controller.filterCount(),0);equal(controller.publishFilter('sleeve',sleeve,preview),false);
  return {perLayerIsolation:true,lateFilterRejected:true};
});
await check('I07','项目身份保护与错误信息，不把异步结果存错项目',()=>{
  let calls=0;const engine={projectId:'project-A'};
  equal(withMatchingCanvasProject(engine,'project-B',()=>++calls),undefined);equal(withMatchingCanvasProject(null,'project-A',()=>++calls),undefined);equal(calls,0);
  equal(withMatchingCanvasProject(engine,'project-A',()=>++calls),1);
  const action=getCanvasGallerySaveErrorAction(new Error('image upload failed'),'project-A','保存失败');
  equal(action.projectId,'project-A');equal(action.context.error,'image upload failed');equal(action.area,'canvas-save-to-gallery');
  return {callbackCount:calls,errorAction:action};
});
await check('I08','真实 RasterBackend 编码 PNG，不使用 Canvas 替身',async()=>{
  const backend=createDomRasterBackend(),surface=backend.createSurface(8,8);surface.ctx.fillStyle='#537456';surface.ctx.fillRect(0,0,8,8);
  const blob=await backend.encodeSurface(surface,'image/png');const bytes=new Uint8Array(await blob.arrayBuffer());
  equal([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);equal(blob.type,'image/png');return {mime:blob.type,bytes:blob.size,backend:surface.canvas.constructor.name};
});
await check('I09','真实像素：全选后反选的空像素与活动选择态差异（假设性边界探针）',()=>{
  const {selection}=harness();selection.selectAll(rect(0,0,8,8));selection.invert(rect(0,0,8,8));
  const actual={nonZeroAlphaPixels:coverage(selection),hasSelection:selection.hasSelection(),maskExists:selection.mask()!==null};
  window.invertEvidence=actual;
  equal(actual.nonZeroAlphaPixels,0);equal(actual.hasSelection,false,'全选后反选像素已全空，但 hasSelection 应为 false');
  return actual;
});
await check('I10','空选区替换与 dispose 释放状态',()=>{
  const h=harness();h.selection.selectAll(rect(0,0,4,4));const source=sourceMask(h.backend,[0,0,0,0],2,2);
  h.selection.replaceMask({rect:rect(0,0,2,2),surface:source});equal(h.selection.hasSelection(),false);equal(h.selection.mask(),null);
  h.selection.selectAll(rect(0,0,4,4));h.selection.dispose();equal(h.selection.mask(),null);equal(h.selection.antsPaths(),[]);return {cleared:true};
});

const negativeInterpretation={
  id:'I09',classification:'Observed selection-state boundary difference; upstream contract requires confirmation; not a confirmed product defect',productBugConfirmed:false,
  hypothesis:'The probe expects an all-transparent invert result to deselect, matching empty subtract/intersect behavior. This is the harness expectation, not an explicit upstream promise.',
  upstreamContract:'selectionState.ts:41 says hasSelection drives clip/fill/ants gating; it does not explicitly define selection existence as nonzero alpha. Lines 1-7 expressly separate structural emptiness from alpha-inspected emptiness.',
  implementation:'selectionState.ts:313-340 traces alpha and clears emptied subtract/intersect; invert at 363-395 sets selected=true without an alpha-empty scan. The measured state is zero covered pixels, a retained mask, and hasSelection=true.',
  downstreamStaticEvidence:[
    {file:'invokeai/frontend/webv2/src/workbench/canvas-engine/engine.ts',lines:'761,958',finding:'The state feeds hasSelection store and ants animation gating; an active-empty selection could keep selected UI/animation state. Full engine behavior was not executed.'},
    {file:'invokeai/frontend/webv2/src/workbench/canvas-engine/render/overlayFrame.ts',lines:'158',finding:'Marching-ants input is gated by hasSelection, not a separate alpha scan. Visible full-app impact was not measured.'},
    {file:'invokeai/frontend/webv2/src/workbench/canvas-engine/selection/selectionOps.ts',lines:'29-59,61-88',finding:'Fill/erase composite through actual mask alpha. The static path supports a no-pixel-change interpretation for a transparent mask, not a claim that the full canvas is edited.'},
    {file:'invokeai/frontend/webv2/src/workbench/canvas-engine/controllers/selectionPixelController.ts',lines:'84-89,185-213',finding:'Controller requires a mask, calls the alpha-masked primitive and checks unchanged raster data before publish. Full controller/history integration not executed.'}
  ],
  adoptionBoundary:'Choose and document whether active-empty selection differs from deselection in the adapter, then test that contract. No upstream source was changed.'
};
checks.find(c=>c.id==='I09').interpretation=negativeInterpretation;
window.invokeResults={suite:'InvokeAI real webv2 modules in Chromium',checks,summary:{passed:checks.filter(c=>c.status==='passed').length,failed:checks.filter(c=>c.status==='failed').length},invertEvidence:window.invertEvidence,negativeInterpretation,realBrowserAPIs:['OffscreenCanvas','Path2D','CanvasRenderingContext2D pixels','PNG encoding'],mocks:['Only I04 injects a Path2D-construction exception through the original dependency seam. No raster or selection implementation is mocked.'],limitations:['No full InvokeAI server or React UI started.','No AI inference, SAM weights, image model or paid API used.','Selection snapshots tested in memory, not project-file or database persistence.']};
document.querySelector('#result').textContent=[
  `测试结果：${window.invokeResults.summary.passed} 项通过；${window.invokeResults.summary.failed} 项边界探针未满足`,
  '',
  ...checks.map(c=>`${c.id}  ${c.status==='passed'?'通过':'边界探针未满足'}  ${c.name}（${c.duration_ms} 毫秒）`),
  '',
  '负面观察：全选 8×8 后同域反选，非零 alpha 像素为 0，但 hasSelection=true，mask 仍存在。',
  '判读：探针预期全空像素会取消选区；上游没有明确承诺这一语义。这是已复现的边界差异，契约待确认，不是已证实的产品缺陷。',
  '影响范围：源码将 hasSelection 用于选区状态和蚂蚁线门控，可能保留活动选择态；完整产品界面没有运行。',
  '像素边界：填充和擦除原语依赖实际 mask alpha，不能据此声称会误改整幅图。',
  '',
  '实际运行：从固定提交直接导入原始源码；使用真实 OffscreenCanvas、Path2D、Canvas 像素读取和 PNG 编码。',
  '注入边界：仅 I04 通过原有依赖注入点模拟一次 Path2D 构造异常；没有替换像素或选区实现。',
  '尚未验证：完整服务器与 React 界面、AI 推理、SAM 权重、项目文件或数据库持久化。',
  '没有调用付费接口，没有安装或升级全局依赖，没有修改上游源码。',
  '',
  '逐项技术数据、源码路径、SHA-256 和失败栈：reports/invoke-results.json',
  '完整中文说明：reports/REPORT.txt'
].join('\n');
