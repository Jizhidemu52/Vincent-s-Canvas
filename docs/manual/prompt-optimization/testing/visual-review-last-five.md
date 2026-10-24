# 后五场景真实图片视觉审阅

在本批次后五场景中，新版并未表现为全面优于旧版。背面生成更少无源装饰；部分工艺细线保留改善。但透明输出契约两版均失败，辅料形状与纹样分工仍存在根本错误，个别工艺近景裁切退化。相对胜出不等于视觉验收通过。

## 范围与口径

仅审阅 `visual-v1` 后五场景。100 条计划记录中 98 张成功图片全部通过 `view_image` 逐张查看；1 条 API 失败、1 条不确定无图，不赋视觉结论。无重新生成、无修改原图或共享账本。遵循 `reviewing-generated-product-designs 0.3.1`：先验输出契约/文字/结构，再看材质和美观；重复根本失败隔离为 `REJECTED`。

主比较排除 72px 辅料素材的 01/02 两组：48 对中，新版胜 6、旧版胜 11、持平 30、无法比较 1。胜出仅表示相对更接近要求，不等于该图 PASS。全部 50 对口径：新版胜 7、旧版胜 11、持平 30、无法比较 2。

98 张判定：PASS 45、MINOR REVISION 13、REDO 12、STOP AND DIAGNOSE 28。

| 场景 | 旧版 PASS / MINOR / REDO / STOP | 新版 PASS / MINOR / REDO / STOP | 主比较 新胜 / 旧胜 / 平 / 未决 |
|---|---:|---:|---:|
| back-design | 8 / 1 / 1 / 0 | 10 / 0 / 0 / 0 | 2 / 0 / 8 / 0 |
| pattern-extract | 3 / 1 / 1 / 5 | 2 / 1 / 2 / 5 | 0 / 2 / 8 / 0 |
| pattern-colorway | 3 / 0 / 0 / 7 | 3 / 0 / 0 / 7 | 1 / 2 / 7 / 0 |
| accessory-design | 2 / 2 / 4 / 2 | 1 / 4 / 2 / 2 | 1 / 5 / 2 / 0 |
| pattern-craft | 7 / 3 / 0 / 0 | 6 / 1 / 2 / 0 | 2 / 2 / 5 / 1 |

## 主要拒收证据

### transparent-background-contract

22 张要求保留源 alpha 的成功 API 输出，alpha 均为 255，含纯色或烘焙棋盘格。

诊断边界：当前证据证明交付产物不透明；未定位是模型能力、供应商参数还是资产管线，不能仅归咎提示词。

最小修正：回到原 PNG 检查输入/供应商原始字节与落盘字节的 alpha；先解决格式契约，不继续盲生成。

### accessory-mode-and-count

高清 03/05/09 的新版均保持圆扣外缘而非六瓣；07 两版四叶变三叶；09 旧版两孔变四孔。

诊断边界：视觉表现符合表面纹样优先而外形/连接约束失效；需要逐项对照编译提示词和图像行为。

最小修正：将外边界、表面纹样、连接孔分别列为硬性验收；失败图禁止作为新参考。

### extraction-reconstruction-leakage

针织单独图案 03/09 新版推断成完整雪花单元，旧版输出整幅多带纹样；06 新版重排中央关系。

诊断边界：低分辨率且裁片缺乏明确独立单元，不能把隐含循环推断当提取事实。

最小修正：明确可见单元/裁切边界；没有证据的部分不补全，必要时报告不足。

### craft-framing-and-detail

毛巾绣 07 两版漏花瓣内细线；新版 02/10 的近景裁切破坏完整图案。

诊断边界：工艺渲染/产品摄影风格压过结构完整性。

最小修正：规定全图案留边、六瓣/四叶完整，细线保留后再表达工艺。

## 未出图记录

| Case | API 状态 | 视觉结果 |
|---|---|---|
| accessory-design-02-new | failed | 无图，不打分、不自动补发 |
| pattern-craft-03-new | uncertain | 无图，不打分、不自动补发 |

## 逐对结论

| 对照 | 旧版 | 新版 | 相对结果 | 原因 |
|---|---|---|---|---|
| accessory-design-01（主比较排除） | [REDO](quality-matrix/visual-v1/accessory-design-01-old-d2116226-c08a-4eb1-aafa-3aea96f2a0cb-1.png) | [PASS](quality-matrix/visual-v1/accessory-design-01-new-908cff8a-1570-4e05-922a-a801b30fdce8-1.png) | 新版胜 | 新版保留棕色纽扣观感，旧版误带入针织背景材质；低清压力例排除主比较。 |
| accessory-design-02（主比较排除） | [REDO](quality-matrix/visual-v1/accessory-design-02-old-bf8acf08-7828-4763-893c-3bf7e0d97edb-1.png) | 无图 | 无法比较 | 新版 API failed，无可查看输出；旧版不作为相对胜出依据。且 72px 辅料素材已排除主比较。 |
| accessory-design-03 | [REDO](quality-matrix/visual-v1/accessory-design-03-old-55c74a30-03a9-42e7-afde-de32c0760a43-1.png) | [REDO](quality-matrix/visual-v1/accessory-design-03-new-0e6d4b6c-f028-4a79-898e-f1ac05c2a90c-1.png) | 持平 | 旧版少一瓣，新版未改外缘；两者各有核心要求失败。 |
| accessory-design-04 | [MINOR REVISION](quality-matrix/visual-v1/accessory-design-04-old-bd9486ad-9b98-4fca-8bb4-e78102e8a7e8-1.png) | [MINOR REVISION](quality-matrix/visual-v1/accessory-design-04-new-46249e3f-6bd4-43ef-83c9-3b6efbbd8a65-1.png) | 旧版胜 | 两版都改动了参考叶枝数量；旧版额外修改更少，保留原布面背景，新版改为白底。 |
| accessory-design-05 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/accessory-design-05-old-e647ff23-2405-46f2-8f41-68ce4c84569e-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/accessory-design-05-new-c700d269-b170-47aa-a09e-4cc0335cdeb0-1.png) | 持平 | 两版重复各自根本结构错误，均不可接受。 |
| accessory-design-06 | [PASS](quality-matrix/visual-v1/accessory-design-06-old-060e7f13-92fe-487d-bda2-300ac3702d2b-1.png) | [MINOR REVISION](quality-matrix/visual-v1/accessory-design-06-new-e43459a9-d288-46cc-a3be-d05123abc367-1.png) | 旧版胜 | 旧版保留原背景且正确完成表面花纹；新版无必要改成白底。 |
| accessory-design-07 | [REDO](quality-matrix/visual-v1/accessory-design-07-old-96d9f3a7-4500-42a7-b410-482d04a562f5-1.png) | [REDO](quality-matrix/visual-v1/accessory-design-07-new-8bd2bbd0-f744-45f6-82b4-9f991deb616c-1.png) | 旧版胜 | 两版都少一叶；旧版至少同时应用绿叶表面纹样，新版还保留原几何纹样而未完成双重要求。 |
| accessory-design-08 | [PASS](quality-matrix/visual-v1/accessory-design-08-old-23970e40-5c52-481a-af12-efcbd8e69057-1.png) | [MINOR REVISION](quality-matrix/visual-v1/accessory-design-08-new-96d86e26-024d-4018-b6ff-748a1afa7096-1.png) | 旧版胜 | 旧版完成表面修改且保留背景；新版额外换白底。 |
| accessory-design-09 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/accessory-design-09-old-f533139d-4aa7-4628-8430-0c00375aaa04-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/accessory-design-09-new-59f2bef4-1105-42da-808b-73aba77225eb-1.png) | 新版胜 | 两版均不可交付，但新版至少守住两孔；旧版还把两孔改四孔并做错瓣数。 |
| accessory-design-10 | [MINOR REVISION](quality-matrix/visual-v1/accessory-design-10-old-4cd9a6a9-fd59-4d8a-84bf-66f3ac52fa7d-1.png) | [MINOR REVISION](quality-matrix/visual-v1/accessory-design-10-new-2a18de61-f08f-4fbb-a544-414703180726-1.png) | 旧版胜 | 两版都重绘叶枝，旧版额外变化较少并保留背景。 |
| back-design-01 | [PASS](quality-matrix/visual-v1/back-design-01-old-800c1854-279d-476f-9063-8c14ba4ff0cf-1.png) | [PASS](quality-matrix/visual-v1/back-design-01-new-e1665f61-9c1d-40b9-ad2c-874436f4d13b-1.png) | 持平 | 两者均满足简洁背面；横育克与无育克属于可接受推演差异。 |
| back-design-02 | [PASS](quality-matrix/visual-v1/back-design-02-old-7c1e9768-c9cf-422d-8ad1-099daebaf2ec-1.png) | [PASS](quality-matrix/visual-v1/back-design-02-new-7d7e679c-516a-4d06-811a-968bc385f19d-1.png) | 持平 | 两者均符合育克背面推演；不把额外方案差异当作原样真实性证明。 |
| back-design-03 | [PASS](quality-matrix/visual-v1/back-design-03-old-8aa3fbbf-0df8-4d34-8a43-7e5fb308c0e7-1.png) | [PASS](quality-matrix/visual-v1/back-design-03-new-2a2d3534-60bf-4bc7-a9cc-0ebdcbef2027-1.png) | 持平 | 两者均正确呈现后中缝与背面方向。 |
| back-design-04 | [PASS](quality-matrix/visual-v1/back-design-04-old-ad2cbffd-9516-4243-8f7b-70eac8c24696-1.png) | [PASS](quality-matrix/visual-v1/back-design-04-new-9ac772f7-daa1-401e-9258-a085c86a7ff8-1.png) | 持平 | 两版均满足一道育克及单细褶；褶长差异在开放范围内。 |
| back-design-05 | [PASS](quality-matrix/visual-v1/back-design-05-old-42d7b7b5-a06a-4e4c-ba41-da50717446a1-1.png) | [PASS](quality-matrix/visual-v1/back-design-05-new-9095e96c-a2b8-4c44-bb11-a6d75d704a6f-1.png) | 持平 | 两版均满足简洁完整后背设计，育克差异在授权范围内。 |
| back-design-06 | [MINOR REVISION](quality-matrix/visual-v1/back-design-06-old-88c73c55-901a-4492-a15c-17ea1083bf3b-1.png) | [PASS](quality-matrix/visual-v1/back-design-06-new-0d7e0cf7-d937-4041-8de5-9ebb7715c7a0-1.png) | 新版胜 | 新版没有旧版无依据的小菱形装饰，更符合简洁背部要求。 |
| back-design-07 | [PASS](quality-matrix/visual-v1/back-design-07-old-cf3658bf-d322-41ea-8e4a-1b50fd41b4e7-1.png) | [PASS](quality-matrix/visual-v1/back-design-07-new-6d3b2d3f-32b8-4ac5-a635-bbae63d10a2a-1.png) | 持平 | 两版均满足明确育克及完整后背要求。 |
| back-design-08 | [PASS](quality-matrix/visual-v1/back-design-08-old-cdb2c5f5-4eb1-4858-a4b1-c0429c5c90db-1.png) | [PASS](quality-matrix/visual-v1/back-design-08-new-0bec9ae7-4308-4c4b-9fd9-ad72eeae2bb6-1.png) | 持平 | 两版均符合中缝背部结构。 |
| back-design-09 | [PASS](quality-matrix/visual-v1/back-design-09-old-581ec66a-f1e3-4bff-96af-060055b2af19-1.png) | [PASS](quality-matrix/visual-v1/back-design-09-new-3193d156-65f5-472e-92f2-9ab6e2c3cc79-1.png) | 持平 | 两版都满足育克和单细褶。 |
| back-design-10 | [REDO](quality-matrix/visual-v1/back-design-10-old-65b863f9-c8b5-4112-8f91-763671bd96af-1.png) | [PASS](quality-matrix/visual-v1/back-design-10-new-6a8dd395-63f6-487b-a093-9cbb5d5c91d4-1.png) | 新版胜 | 新版避免旧版明显的无源菱形装饰，符合简洁要求。 |
| pattern-colorway-01 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-01-old-981b9d08-6847-4590-853b-d208a1cfbdd9-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-01-new-ab738087-4d42-455a-bc36-1d23748d4fc0-1.png) | 持平 | 配色方向各自可接受，但共同全不透明黑底使输出合同失败。 |
| pattern-colorway-02 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-02-old-d1a1ba97-237e-4a74-a9ee-ff1824082cb7-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-02-new-cbfb52e3-901f-42a1-883e-59d770974068-1.png) | 持平 | 两者均烘焙棋盘格、无alpha；旧版线条层次较清楚，但均不满足交付合同。 |
| pattern-colorway-03 | [PASS](quality-matrix/visual-v1/pattern-colorway-03-old-b0c6578b-b79e-493a-8542-1ed232095ff6-1.png) | [PASS](quality-matrix/visual-v1/pattern-colorway-03-new-9fa6ffcb-a349-412d-b870-d7524a652cf0-1.png) | 新版胜 | 两者均未泄漏第二图服装结构；新版深浅几何色区分离更明确。 |
| pattern-colorway-04 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-04-old-66fb5215-2b26-42d8-a6f5-df6ee86e1ea1-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-04-new-6086a729-d307-44a7-bd84-b75f0d3680e3-1.png) | 持平 | 两版均违反透明输出契约；新版额外出现波浪棋盘格，仍不能把任一版本算通过。 |
| pattern-colorway-05 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-05-old-94915d3d-6b7d-4b20-ac50-beaabb3e9dc9-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-05-new-4797cd63-6f27-44f0-95d5-12fe460d7e26-1.png) | 旧版胜 | 两版均失去透明底；旧版枝茎仍清楚，新版深色背景吞没枝茎。 |
| pattern-colorway-06 | [PASS](quality-matrix/visual-v1/pattern-colorway-06-old-85dfde54-2606-42f2-9db6-22b67cd66f9a-1.png) | [PASS](quality-matrix/visual-v1/pattern-colorway-06-new-875fd785-b410-4164-88ea-25949b32d1af-1.png) | 旧版胜 | 两版可用，旧版深浅区分更接近原纹样层次；新版中央大色区合并为近色，识别性稍弱。 |
| pattern-colorway-07 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-07-old-c190a670-ae9a-4dbb-8b70-2a405d66a91f-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-07-new-1294ee6a-66c0-42f4-812c-83d9f820e933-1.png) | 持平 | 两版均不透明黑底；不能只凭暖色色相计通过。 |
| pattern-colorway-08 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-08-old-379b81ca-8101-4084-b829-fa7d709cad93-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-08-new-b5bcf1af-4fdf-4aea-a2eb-3f0c8ffb568c-1.png) | 持平 | 配色可辨但两版均是烘焙棋盘格，核心透明要求失败。 |
| pattern-colorway-09 | [PASS](quality-matrix/visual-v1/pattern-colorway-09-old-44d6572f-aa01-41cf-b1eb-5623492adf6c-1.png) | [PASS](quality-matrix/visual-v1/pattern-colorway-09-new-20b46215-1d52-4eae-8a21-f1c7459e49e2-1.png) | 持平 | 两版均保留整体纹样并完成可接受暖色改色；未做生产级色值判断。 |
| pattern-colorway-10 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-10-old-5a0e5239-8915-45d2-b621-367f7ff238e4-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-colorway-10-new-f8b42093-45ea-4519-8ff9-f172ede4fa91-1.png) | 持平 | 两版均烘焙棋盘格，非透明图案。 |
| pattern-craft-01 | [MINOR REVISION](quality-matrix/visual-v1/pattern-craft-01-old-a4094978-0eb4-4d8d-996b-44ccc545c3d2-1.png) | [PASS](quality-matrix/visual-v1/pattern-craft-01-new-a84a2c47-2410-49eb-838c-1e420b0b2027-1.png) | 新版胜 | 新版细棕色脉线保留更清楚，旧版需要局部补线。 |
| pattern-craft-02 | [PASS](quality-matrix/visual-v1/pattern-craft-02-old-3eea253f-5a09-46b9-b4ba-8b55737e768d-1.png) | [REDO](quality-matrix/visual-v1/pattern-craft-02-new-55d105da-d793-434e-b7bc-d864f4438c2e-1.png) | 旧版胜 | 旧版完整保留四叶与茎，提花清楚；新版右叶与茎端裁切。 |
| pattern-craft-03 | [PASS](quality-matrix/visual-v1/pattern-craft-03-old-94e4b8c5-0f7e-403d-aba8-f25e55339a65-1.png) | 无图 | 无法比较 | 新版 uncertain 且无输出，只能记录旧版 PASS，不能判断新旧相对优劣。 |
| pattern-craft-04 | [PASS](quality-matrix/visual-v1/pattern-craft-04-old-5d1310cb-6f6e-4cf9-94ee-9260a6492489-1.png) | [PASS](quality-matrix/visual-v1/pattern-craft-04-new-831d2905-d8dd-44dd-a16a-34b0d55a7ab6-1.png) | 持平 | 两版均有完整正确图案及胶印观感，视角不同不构成必要优劣。 |
| pattern-craft-05 | [PASS](quality-matrix/visual-v1/pattern-craft-05-old-de16104a-3544-48ab-9880-6ea0a3bf173c-1.png) | [PASS](quality-matrix/visual-v1/pattern-craft-05-new-b71a14fa-68fd-4a4b-bf6f-1ef82627bc65-1.png) | 持平 | 两版均忠实四叶枝并有合适刺绣及针织底面观感。 |
| pattern-craft-06 | [PASS](quality-matrix/visual-v1/pattern-craft-06-old-9d31bbc1-feed-4f70-8737-4499f9408b5d-1.png) | [PASS](quality-matrix/visual-v1/pattern-craft-06-new-acdf2815-9665-4b16-82bb-4201f1db47fe-1.png) | 持平 | 两版均体现要求的织造观感与原配色图案。 |
| pattern-craft-07 | [MINOR REVISION](quality-matrix/visual-v1/pattern-craft-07-old-af5c6ad7-3223-4aef-9ded-1955ff8b538f-1.png) | [MINOR REVISION](quality-matrix/visual-v1/pattern-craft-07-new-09ffc644-e7cc-4bf6-871b-03bf03a5cf93-1.png) | 持平 | 两版毛巾绣观感均好，但都漏掉原花瓣内细线，均需局部返修。 |
| pattern-craft-08 | [MINOR REVISION](quality-matrix/visual-v1/pattern-craft-08-old-fe328ed1-6be9-4d2c-aa22-fa6fa44bb6d7-1.png) | [PASS](quality-matrix/visual-v1/pattern-craft-08-new-9b2e7a10-4a16-4189-a884-2e76eee456cc-1.png) | 新版胜 | 新版完整保留深绿轮廓，旧版遗漏外围深色线。 |
| pattern-craft-09 | [PASS](quality-matrix/visual-v1/pattern-craft-09-old-4fc4bd11-5ae9-4fcc-8d33-8937324c2e3d-1.png) | [PASS](quality-matrix/visual-v1/pattern-craft-09-new-e3376ea9-5c0c-4831-a008-410823bbc95c-1.png) | 持平 | 两版均有正确刺绣/帆布区分与原几何配色。 |
| pattern-craft-10 | [PASS](quality-matrix/visual-v1/pattern-craft-10-old-c603290c-a9c1-4fb7-950a-cc1de8a5bd78-1.png) | [REDO](quality-matrix/visual-v1/pattern-craft-10-new-316c1f34-8a3b-45f6-a1e2-aaa78277ad75-1.png) | 旧版胜 | 旧版完整保留花朵；新版裁掉右下花瓣。 |
| pattern-extract-01 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-01-old-5ead785b-f001-4665-b4e5-bf4971aa444c-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-01-new-0d696194-7404-4ab8-9a7a-891402aa1347-1.png) | 持平 | 两者均丢失源alpha，均未通过；新版黑底不能当透明改善。 |
| pattern-extract-02 | [PASS](quality-matrix/visual-v1/pattern-extract-02-old-dff0361b-5e79-44e0-8d53-183a22acfa35-1.png) | [PASS](quality-matrix/visual-v1/pattern-extract-02-new-1c703f88-4a19-492e-92df-134261ee002c-1.png) | 持平 | 两者均保留四叶结构并按字段输出白底。 |
| pattern-extract-03 | [REDO](quality-matrix/visual-v1/pattern-extract-03-old-577514a0-0b01-4a97-b82c-0d5950b08894-1.png) | [REDO](quality-matrix/visual-v1/pattern-extract-03-new-11ada841-e100-47ee-a423-b425f7c8a29d-1.png) | 持平 | 旧版未按单独图案输出，新版重组并新增单元；两者均不能作为忠实提取。 |
| pattern-extract-04 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-04-old-e72da686-fedb-4c8a-9f2d-6d14713ada48-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-04-new-4b8803e7-f5d5-4335-adb9-1d1eec0c1cde-1.png) | 持平 | 两版同样失败：透明源图变不透明黑底。 |
| pattern-extract-05 | [PASS](quality-matrix/visual-v1/pattern-extract-05-old-5788c1b5-2ac7-4554-8cbe-d0b85aa326ed-1.png) | [MINOR REVISION](quality-matrix/visual-v1/pattern-extract-05-new-616b980c-fc69-4c8e-8308-a4786e5bba79-1.png) | 旧版胜 | 旧版线边更清晰；新版引入毛边颗粒，不利于忠实提取。 |
| pattern-extract-06 | [MINOR REVISION](quality-matrix/visual-v1/pattern-extract-06-old-40593b25-b17f-42da-9986-f5beb2a59de6-1.png) | [REDO](quality-matrix/visual-v1/pattern-extract-06-new-46382f63-32ba-4232-9d54-c403942d983b-1.png) | 旧版胜 | 旧版虽残留针目但可见主布局更接近来源；新版重新排列中央几何。 |
| pattern-extract-07 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-07-old-8dc418b8-ff1a-400f-84c5-fecd1f2827b6-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-07-new-ff8de2b4-3d58-4daa-b70e-448c419d7a4a-1.png) | 持平 | 两版主体成立但透明契约均失败。 |
| pattern-extract-08 | [PASS](quality-matrix/visual-v1/pattern-extract-08-old-231b83d8-bf37-4631-becd-fe5278720212-1.png) | [PASS](quality-matrix/visual-v1/pattern-extract-08-new-7ecb11f1-6529-472e-8d13-d141aa888b8b-1.png) | 持平 | 两版均完整保留四叶枝并正确输出白底。 |
| pattern-extract-09 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-09-old-9ba86d6d-f202-4591-965d-8b883dad8f0d-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-09-new-af75c3de-a4f1-4c62-8c21-6582ac8d7fc2-1.png) | 持平 | 旧版忽略单独模式，新版臆造完整单元，两版均根本失败。 |
| pattern-extract-10 | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-10-old-3298298c-a274-4384-b48b-8ff609e2866e-1.png) | [STOP AND DIAGNOSE](quality-matrix/visual-v1/pattern-extract-10-new-898aa98e-1022-491f-9a44-d41418d39bb1-1.png) | 持平 | 两版同样不透明黑底，核心输出契约失败。 |

## 逐图观察与修正

每个链接直达原始落盘图；SHA-256 与完整观察、失败项、修正 brief、未验证项保存在同名 JSON。

| 图片 | 结论 | 具体观察/失败 | 最小修正 |
|---|---|---|---|
| [accessory-design-01-new](quality-matrix/visual-v1/accessory-design-01-new-908cff8a-1570-4e05-922a-a801b30fdce8-1.png) | PASS | 四片叶的外轮廓形成棕色纽扣；有可见连接孔，未引入拉链或链条。 主体保持棕色硬质纽扣观感，不误用背景针织为主体。 | 本低分辨率压力例不进入主比较；生产前需更高清的原始辅料。 |
| [accessory-design-01-old](quality-matrix/visual-v1/accessory-design-01-old-d2116226-c08a-4eb1-aafa-3aea96f2a0cb-1.png) | REDO | 纽扣主体被改成奶油纺织质感；疑似把原纽扣周围针织底布当成主体材质，未保留棕色纽扣观感。 | 图1仅取棕色纽扣主体，周围针织底布不是纽扣材质；图2仅决定叶形外缘，保留原连接功能。 |
| [accessory-design-02-old](quality-matrix/visual-v1/accessory-design-02-old-bf8acf08-7828-4763-893c-3bf7e0d97edb-1.png) | REDO | 原棕色纽扣主体被替换为奶油纺织包扣观感，错误引入周围针织底布材质。 花心点被孔和穿线覆盖，完整原图案身份无法保留。 | 仅在原棕色纽扣表面应用图2图案，保持圆形外缘、硬质观感及原连接部位；不能把背景布当纽扣材质。 |
| [accessory-design-03-new](quality-matrix/visual-v1/accessory-design-03-new-0e6d4b6c-f028-4a79-898e-f1ac05c2a90c-1.png) | REDO | 明确要求把图2轮廓应用到钮扣外缘，但结果仍是圆形，只做了表面纹样。 把“形状与纹样”错误执行为“仅表面纹样”。 | 保持两孔连接结构，把原圆外缘改成图2六瓣外轮廓；不能只在圆扣上画花。 |
| [accessory-design-03-old](quality-matrix/visual-v1/accessory-design-03-old-55c74a30-03a9-42e7-afde-de32c0760a43-1.png) | REDO | 只有五片花瓣，而图片2明确为六瓣花；参考2的形状被改写。 | 从原两孔钮扣和六瓣花重新约束外缘为六瓣，保留两孔位置与棕边材质，不删瓣或添瓣。 |
| [accessory-design-04-new](quality-matrix/visual-v1/accessory-design-04-new-46249e3f-6bd4-43ef-83c9-3b6efbbd8a65-1.png) | MINOR REVISION | 参考为不对称四叶枝，结果重绘为五叶/更多叶的重复枝纹；不是原图案的忠实应用。 额外把原布面背景改成白底，超出仅表面修改。 | 用原始四叶枝图案铺排，锁定叶数和连接关系；保留按钮外形、四孔、边沿及原布面背景。 |
| [accessory-design-04-old](quality-matrix/visual-v1/accessory-design-04-old-bd9486ad-9b98-4fca-8bb4-e78102e8a7e8-1.png) | MINOR REVISION | 参考为不对称四叶枝，结果重绘为五叶/更多叶的重复枝纹；不是原图案的忠实应用。 | 用原始四叶枝图案铺排，锁定叶数和连接关系；保留按钮外形、四孔、边沿及原布面背景。 |
| [accessory-design-05-new](quality-matrix/visual-v1/accessory-design-05-new-c700d269-b170-47aa-a09e-4cc0335cdeb0-1.png) | STOP AND DIAGNOSE | 仍是圆扣外缘；重复 03 的“只做表面纹样而未改外形”错误。 | 停用该失败图；将六瓣轮廓直接定义为产品外边界，而非圆形扣内装饰。 |
| [accessory-design-05-old](quality-matrix/visual-v1/accessory-design-05-old-e647ff23-2405-46f2-8f41-68ce4c84569e-1.png) | STOP AND DIAGNOSE | 六瓣参考再次被改成五瓣外缘；与 03 重复同一结构错误。 | 停用该失败图；从六瓣原图明确六瓣闭合外缘，保持两孔，核对计数后再交付。 |
| [accessory-design-06-new](quality-matrix/visual-v1/accessory-design-06-new-e43459a9-d288-46cc-a3be-d05123abc367-1.png) | MINOR REVISION | 仅表面修改任务额外将原布面背景改为白底。 | 保持现有正确花纹与连接孔，恢复原参考布面背景。 |
| [accessory-design-06-old](quality-matrix/visual-v1/accessory-design-06-old-060e7f13-92fe-487d-bda2-300ac3702d2b-1.png) | PASS | 圆形、四孔、棕色边沿与布面背景保留。 六瓣珊瑚花与黄花心作为表面装饰；孔洞自然遮挡部分中心小点。 | 无需概念级返修；不把孔洞遮挡误判为必须补回全部中心点。 |
| [accessory-design-07-new](quality-matrix/visual-v1/accessory-design-07-new-8bd2bbd0-f744-45f6-82b4-9f991deb616c-1.png) | REDO | 四叶变三叶。 仍填原几何针织花纹，未把图2叶纹应用到表面，形状与纹样只执行一部分。 | 锁定四叶轮廓，并把图2绿叶纹样对应到各叶瓣，保持原针织材质而非原几何纹样。 |
| [accessory-design-07-old](quality-matrix/visual-v1/accessory-design-07-old-96d9f3a7-4500-42a7-b410-482d04a562f5-1.png) | REDO | 四叶原图被删成三叶，轮廓数量与不对称结构错误。 | 保留四片原叶及其连接关系，四叶外形与表面叶纹同时落实；保留两孔。 |
| [accessory-design-08-new](quality-matrix/visual-v1/accessory-design-08-new-96d86e26-024d-4018-b6ff-748a1afa7096-1.png) | MINOR REVISION | 仅表面修改任务仍额外改变原布面背景为白底。 | 保留正确产品与花纹，恢复原背景。 |
| [accessory-design-08-old](quality-matrix/visual-v1/accessory-design-08-old-23970e40-5c52-481a-af12-efcbd8e69057-1.png) | PASS | 六瓣表面花纹正确；四孔、圆形边沿、原布面背景保持。 | 无需概念级返修。 |
| [accessory-design-09-new](quality-matrix/visual-v1/accessory-design-09-new-59f2bef4-1105-42da-808b-73aba77225eb-1.png) | STOP AND DIAGNOSE | 第三次仍保持圆形外缘，未执行明确改成六瓣外轮廓。 | 停用圆扣结果；诊断为何外边界指令被表面花纹替代，回到原源图实施边界级改形。 |
| [accessory-design-09-old](quality-matrix/visual-v1/accessory-design-09-old-f533139d-4aa7-4628-8430-0c00375aaa04-1.png) | STOP AND DIAGNOSE | 六瓣继续变五瓣，重复早先结构错误。 两孔参考被改成四孔，连接结构也发生未经授权改变。 | 停止同样输入的盲重试；从两孔源扣和六瓣原图分别锁定连接孔与外边界。 |
| [accessory-design-10-new](quality-matrix/visual-v1/accessory-design-10-new-2a18de61-f08f-4fbb-a544-414703180726-1.png) | MINOR REVISION | 原不对称四叶枝被重绘成更多叶片的枝纹，图案身份不完全一致。 原布面背景被改成白底。 | 直接应用原四叶枝图，不更改叶数或连接关系；保留原背景。 |
| [accessory-design-10-old](quality-matrix/visual-v1/accessory-design-10-old-4cd9a6a9-fd59-4d8a-84bf-66f3ac52fa7d-1.png) | MINOR REVISION | 原不对称四叶枝被重绘成更多叶片的枝纹，图案身份不完全一致。 | 直接应用原四叶枝图，不更改叶数或连接关系；保留原背景。 |
| [back-design-01-new](quality-matrix/visual-v1/back-design-01-new-e1665f61-9c1d-40b9-ad2c-874436f4d13b-1.png) | PASS | 完整蓝色短袖简洁背面，无前门襟、纽扣或额外装饰。 肩宽、袖长、弧形下摆、淡蓝色梭织观感与参考相符。 | 无需视觉返修；作为新背面方案，不代表已知真实背面。 |
| [back-design-01-old](quality-matrix/visual-v1/back-design-01-old-800c1854-279d-476f-9063-8c14ba4ff0cf-1.png) | PASS | 完整蓝色短袖背面；横向育克，无前门襟或纽扣。 肩宽、袖长、弧形下摆、淡蓝色梭织观感与参考相符。 | 无需视觉返修；作为新背面方案，不代表已知真实背面。 |
| [back-design-02-new](quality-matrix/visual-v1/back-design-02-new-7d7e679c-516a-4d06-811a-968bc385f19d-1.png) | PASS | 米色短袖示意背面带横育克和小中心褶；前扣与胸袋未错误搬到背面。 原参考的长度、袖型、浅色领部和图示风格保留。 | 背面结构属于设计推演，不能当作原款实际背面。 |
| [back-design-02-old](quality-matrix/visual-v1/back-design-02-old-7c1e9768-c9cf-422d-8ad1-099daebaf2ec-1.png) | PASS | 米色短袖示意背面带浅V形育克；前扣与胸袋未错误搬到背面。 原参考的长度、袖型、浅色领部和图示风格保留。 | 背面结构属于设计推演，不能当作原款实际背面。 |
| [back-design-03-new](quality-matrix/visual-v1/back-design-03-new-2a2d3534-60bf-4bc7-a9cc-0ebdcbef2027-1.png) | PASS | 蓝色短袖完整背面，纵向后中缝清楚，未把前门襟纽扣复制到背面。 面料、色彩、肩宽、袖长和弧形下摆保持参考关系。 | 无需视觉返修；后中缝属于本次授权设计推演。 |
| [back-design-03-old](quality-matrix/visual-v1/back-design-03-old-8aa3fbbf-0df8-4d34-8a43-7e5fb308c0e7-1.png) | PASS | 蓝色短袖完整背面，纵向后中缝清楚，未把前门襟纽扣复制到背面。 面料、色彩、肩宽、袖长和弧形下摆保持参考关系。 | 无需视觉返修；后中缝属于本次授权设计推演。 |
| [back-design-04-new](quality-matrix/visual-v1/back-design-04-new-9ac772f7-daa1-401e-9258-a085c86a7ff8-1.png) | PASS | 后背为完整单视图；保留原米色短袖衬衫外形。 一道横向育克及其下方一处细褶，与自由描述一致；其余保持简洁。 | 无需概念级视觉返修；后背是授权设计提案，不是已验证的实物背面。 |
| [back-design-04-old](quality-matrix/visual-v1/back-design-04-old-ad2cbffd-9516-4243-8f7b-70eac8c24696-1.png) | PASS | 后背为完整单视图；保留原米色短袖衬衫外形。 一道横向育克及其下方一处细褶，与自由描述一致；其余保持简洁。 | 无需概念级视觉返修；后背是授权设计提案，不是已验证的实物背面。 |
| [back-design-05-new](quality-matrix/visual-v1/back-design-05-new-9095e96c-a2b8-4c44-bb11-a6d75d704a6f-1.png) | PASS | 完整浅蓝短袖后背视图，肩宽、袖长、下摆弧度与正面一致。 没有复制前门襟或纽扣；简洁后背结构合理。 | 无需概念级视觉返修；后背结构是授权提案。 |
| [back-design-05-old](quality-matrix/visual-v1/back-design-05-old-42d7b7b5-a06a-4e4c-ba41-da50717446a1-1.png) | PASS | 完整浅蓝短袖后背视图，肩宽、袖长、下摆弧度与正面一致。 没有复制前门襟或纽扣；简洁后背结构合理。 | 无需概念级视觉返修；后背结构是授权提案。 |
| [back-design-06-new](quality-matrix/visual-v1/back-design-06-new-0d7e0cf7-d937-4041-8de5-9ebb7715c7a0-1.png) | PASS | 米色短袖完整后背、简洁无额外装饰，符合参考风格。 | 无需概念级视觉返修。 |
| [back-design-06-old](quality-matrix/visual-v1/back-design-06-old-88c73c55-901a-4492-a15c-17ea1083bf3b-1.png) | MINOR REVISION | 简洁背部出现无源的小菱形装饰，未由正面风格或文字要求支持。 | 去掉小菱形装饰；仅保留合理简洁后背结构。 |
| [back-design-07-new](quality-matrix/visual-v1/back-design-07-new-6d3b2d3f-32b8-4ac5-a635-bbae63d10a2a-1.png) | PASS | 浅蓝衬衫完整后背、水平育克线清楚。 袖型、下摆弧度与材质一致，没有正面纽扣门襟误复制。 | 无需概念级返修。 |
| [back-design-07-old](quality-matrix/visual-v1/back-design-07-old-cf3658bf-d322-41ea-8e4a-1b50fd41b4e7-1.png) | PASS | 浅蓝衬衫完整后背、水平育克线清楚。 袖型、下摆弧度与材质一致，没有正面纽扣门襟误复制。 | 无需概念级返修。 |
| [back-design-08-new](quality-matrix/visual-v1/back-design-08-new-0bec9ae7-4308-4c4b-9fd9-ad72eeae2bb6-1.png) | PASS | 完整米色短袖后背，中缝清楚贯通。 未出现前门襟、胸袋或新增背部图案，参考风格保持。 | 无需概念级视觉返修。 |
| [back-design-08-old](quality-matrix/visual-v1/back-design-08-old-cdb2c5f5-4eb1-4858-a4b1-c0429c5c90db-1.png) | PASS | 完整米色短袖后背，中缝清楚贯通。 未出现前门襟、胸袋或新增背部图案，参考风格保持。 | 无需概念级视觉返修。 |
| [back-design-09-new](quality-matrix/visual-v1/back-design-09-new-3193d156-65f5-472e-92f2-9ab6e2c3cc79-1.png) | PASS | 完整浅蓝衬衫后背；一条横向育克和下方单细褶清楚。 其余背部简洁，材质、袖型和下摆保持。 | 无需概念级视觉返修。 |
| [back-design-09-old](quality-matrix/visual-v1/back-design-09-old-581ec66a-f1e3-4bff-96af-060055b2af19-1.png) | PASS | 完整浅蓝衬衫后背；一条横向育克和下方单细褶清楚。 其余背部简洁，材质、袖型和下摆保持。 | 无需概念级视觉返修。 |
| [back-design-10-new](quality-matrix/visual-v1/back-design-10-new-6a8dd395-63f6-487b-a093-9cbb5d5c91d4-1.png) | PASS | 完整米色短袖后背；简洁无无源装饰。 没有照搬前门襟或胸袋。 | 无需概念级视觉返修。 |
| [back-design-10-old](quality-matrix/visual-v1/back-design-10-old-65b863f9-c8b5-4112-8f91-763671bd96af-1.png) | REDO | 简洁背部出现无依据的大白菱形与单侧横线，不来自前图，也未被文字授权。 | 删除新增菱形装饰及其横线，保持简洁背面和原参考风格。 |
| [pattern-colorway-01-new](quality-matrix/visual-v1/pattern-colorway-01-new-ab738087-4d42-455a-bc36-1d23748d4fc0-1.png) | STOP AND DIAGNOSE | 原透明背景变成全不透明黑底；只读像素确认0透明像素。 图案外围轮廓有轻微重绘，不能视为精确换色。 | 先修正alpha输出链；从原透明图进行只改色处理，保留轮廓与五点位置。 |
| [pattern-colorway-01-old](quality-matrix/visual-v1/pattern-colorway-01-old-981b9d08-6847-4590-853b-d208a1cfbdd9-1.png) | STOP AND DIAGNOSE | 原透明背景变成全不透明黑底；只读像素确认0透明像素。 图案外围轮廓有轻微重绘，不能视为精确换色。 | 先修正alpha输出链；从原透明图进行只改色处理，保留轮廓与五点位置。 |
| [pattern-colorway-02-new](quality-matrix/visual-v1/pattern-colorway-02-new-cbfb52e3-901f-42a1-883e-59d770974068-1.png) | STOP AND DIAGNOSE | 灰白棋盘格是烘焙进RGB的实体背景；与明确“透明背景保持透明”相违背。 外轮廓线和叶片主体合成同色，原线稿层次弱化。 | 先检查并修复RGBA透明输出，禁止绘制棋盘格代替alpha；回到原四叶图保留原轮廓、脉线与位置只改色。 |
| [pattern-colorway-02-old](quality-matrix/visual-v1/pattern-colorway-02-old-d1a1ba97-237e-4a74-a9ee-ff1824082cb7-1.png) | STOP AND DIAGNOSE | 灰白棋盘格是烘焙进RGB的实体背景；与明确“透明背景保持透明”相违背。 | 先检查并修复RGBA透明输出，禁止绘制棋盘格代替alpha；回到原四叶图保留原轮廓、脉线与位置只改色。 |
| [pattern-colorway-03-new](quality-matrix/visual-v1/pattern-colorway-03-new-9fa6ffcb-a349-412d-b870-d7524a652cf0-1.png) | PASS | 原图的针织带状布局、中央几何、左侧布褶均可识别。 配色改为第二图的米色/棕色/奶油色关系，没有引入衬衫外形、口袋或纽扣。 深棕菱形与浅棕大几何分区较清楚。 | 无需概念级视觉返修；若用于精确图案换色，需本地逐色替换核验。 |
| [pattern-colorway-03-old](quality-matrix/visual-v1/pattern-colorway-03-old-b0c6578b-b79e-493a-8542-1ed232095ff6-1.png) | PASS | 原图的针织带状布局、中央几何、左侧布褶均可识别。 配色改为第二图的米色/棕色/奶油色关系，没有引入衬衫外形、口袋或纽扣。 同棕色映射使部分相邻几何的色彩分离较弱。 | 无需概念级视觉返修；若用于精确图案换色，需本地逐色替换核验。 |
| [pattern-colorway-04-new](quality-matrix/visual-v1/pattern-colorway-04-new-6086a729-d307-44a7-bd84-b75f0d3680e3-1.png) | STOP AND DIAGNOSE | 输出把棋盘格烘焙成 RGB 背景，没有保留透明通道。 背景棋盘格还出现不规则波浪/密度变化，造成额外视觉伪影。 | 隔离此输出，不作新参考；核实图像模型与资产管线的真实 alpha 支持，再用原始透明源图修复输出契约。 |
| [pattern-colorway-04-old](quality-matrix/visual-v1/pattern-colorway-04-old-66fb5215-2b26-42d8-a6f5-df6ee86e1ea1-1.png) | STOP AND DIAGNOSE | 输出把棋盘格烘焙成 RGB 背景，没有保留透明通道。 | 隔离此输出，不作新参考；核实图像模型与资产管线的真实 alpha 支持，再用原始透明源图修复输出契约。 |
| [pattern-colorway-05-new](quality-matrix/visual-v1/pattern-colorway-05-new-4797cd63-6f27-44f0-95d5-12fe460d7e26-1.png) | STOP AND DIAGNOSE | 透明背景被整幅深蓝填充。 叶缘轮廓、枝茎与背景融合，茎和深色轮廓可读性丢失。 | 保留透明背景并将深蓝限定于原轮廓与枝茎，禁止填背景或吞没结构。 |
| [pattern-colorway-05-old](quality-matrix/visual-v1/pattern-colorway-05-old-94915d3d-6b7d-4b20-ac50-beaabb3e9dc9-1.png) | STOP AND DIAGNOSE | 透明底变不透明黑底；原外围深色轮廓还被改成同色阴影。 | 保留原 alpha、轮廓和茎叶结构，只替换已有色块；先核实透明管线。 |
| [pattern-colorway-06-new](quality-matrix/visual-v1/pattern-colorway-06-new-875fd785-b410-4164-88ea-25949b32d1af-1.png) | PASS | 针织实拍裁片和几何条带保留，改为来自米色衣图的棕/奶油色体系。 未引入第二张参考的服装结构。 | 无需概念级返修；生产用色号及小针格需另核。 |
| [pattern-colorway-06-old](quality-matrix/visual-v1/pattern-colorway-06-old-85dfde54-2606-42f2-9db6-22b67cd66f9a-1.png) | PASS | 针织实拍裁片和几何条带保留，改为来自米色衣图的棕/奶油色体系。 未引入第二张参考的服装结构。 | 无需概念级返修；生产用色号及小针格需另核。 |
| [pattern-colorway-07-new](quality-matrix/visual-v1/pattern-colorway-07-new-1294ee6a-66c0-42f4-812c-83d9f820e933-1.png) | STOP AND DIAGNOSE | 原透明底再次变不透明黑底；改色不能代替透明契约。 | 隔离结果；核实 alpha 通道管线后从原透明源图修复，禁止继续以失败图作参考。 |
| [pattern-colorway-07-old](quality-matrix/visual-v1/pattern-colorway-07-old-c190a670-ae9a-4dbb-8b70-2a405d66a91f-1.png) | STOP AND DIAGNOSE | 原透明底再次变不透明黑底；改色不能代替透明契约。 | 隔离结果；核实 alpha 通道管线后从原透明源图修复，禁止继续以失败图作参考。 |
| [pattern-colorway-08-new](quality-matrix/visual-v1/pattern-colorway-08-new-b5bcf1af-4fdf-4aea-a2eb-3f0c8ffb568c-1.png) | STOP AND DIAGNOSE | 透明背景被烘焙棋盘格取代，alpha 全 255。 图案线边被重新绘制为轻微毛边，非原图严格保形。 | 先解决真实透明通道；基于原轮廓仅置换色块，不烘焙预览网格或重画笔触。 |
| [pattern-colorway-08-old](quality-matrix/visual-v1/pattern-colorway-08-old-379b81ca-8101-4084-b829-fa7d709cad93-1.png) | STOP AND DIAGNOSE | 透明背景被烘焙棋盘格取代，alpha 全 255。 图案线边被重新绘制为轻微毛边，非原图严格保形。 | 先解决真实透明通道；基于原轮廓仅置换色块，不烘焙预览网格或重画笔触。 |
| [pattern-colorway-09-new](quality-matrix/visual-v1/pattern-colorway-09-new-20b46215-1d52-4eae-8a21-f1c7459e49e2-1.png) | PASS | 几何条带与针织布面保留；棕/米色暖调方向正确。 配色参考没有被误用为服装结构。 | 无需概念级返修；生产用色及每针格对位另核。 |
| [pattern-colorway-09-old](quality-matrix/visual-v1/pattern-colorway-09-old-44d6572f-aa01-41cf-b1eb-5623492adf6c-1.png) | PASS | 几何条带与针织布面保留；棕/米色暖调方向正确。 配色参考没有被误用为服装结构。 | 无需概念级返修；生产用色及每针格对位另核。 |
| [pattern-colorway-10-new](quality-matrix/visual-v1/pattern-colorway-10-new-f8b42093-45ea-4519-8ff9-f172ede4fa91-1.png) | STOP AND DIAGNOSE | 所谓透明背景实际是烘焙棋盘格，没有 alpha。 | 不重复盲重试；从原透明源图解决模型输出/资产管线的 alpha 契约，失败结果隔离。 |
| [pattern-colorway-10-old](quality-matrix/visual-v1/pattern-colorway-10-old-5a0e5239-8915-45d2-b621-367f7ff238e4-1.png) | STOP AND DIAGNOSE | 所谓透明背景实际是烘焙棋盘格，没有 alpha。 | 不重复盲重试；从原透明源图解决模型输出/资产管线的 alpha 契约，失败结果隔离。 |
| [pattern-craft-01-new](quality-matrix/visual-v1/pattern-craft-01-new-a84a2c47-2410-49eb-838c-1e420b0b2027-1.png) | PASS | 六瓣五点与细棕色脉线均清楚；珊瑚花瓣、黄色花心和棕边保留。 刺绣线迹位于棉布表面，边缘收口合理。 | 无需视觉返修；不代表真实针迹文件或可直接打样数据。 |
| [pattern-craft-01-old](quality-matrix/visual-v1/pattern-craft-01-old-a4094978-0eb4-4d8d-996b-44ccc545c3d2-1.png) | MINOR REVISION | 部分花瓣原有细棕色脉线被同色针迹流向弱化，图案细线身份不够明确。 | 保留现有刺绣效果，在每瓣原位置恢复清楚、细窄的棕色脉线；不加新纹样。 |
| [pattern-craft-02-new](quality-matrix/visual-v1/pattern-craft-02-new-55d105da-d793-434e-b7bc-d864f4438c2e-1.png) | REDO | 右侧叶尖与下端茎被画幅裁掉；斜视近拍使完整图案边界不能核对。 超浅景深弱化部分图案边缘，偏离保持原形状与比例的核对用途。 | 从原图重做完整俯视提花效果，四叶及茎端全部入画，保留边界留白与清晰线圈；不增加新图案。 |
| [pattern-craft-02-old](quality-matrix/visual-v1/pattern-craft-02-old-3eea253f-5a09-46b9-b4ba-8b55737e768d-1.png) | PASS | 四叶单茎、绿色主体与深色脉线以针织V形线圈表达。 图案与针织底面一体，符合提花模拟，没有额外图案。 | 无需视觉返修；黑色底布为未限定底色的方案选择，不证明真实组织图。 |
| [pattern-craft-03-old](quality-matrix/visual-v1/pattern-craft-03-old-94e4b8c5-0f7e-403d-aba8-f25e55339a65-1.png) | PASS | 原几何分区和奶油/深蓝/砖红/芥末色关系保留。 凸起密集绒圈/簇绒与帆布底面有区分，符合毛巾绣观感。 | 无需概念级视觉返修；真实绒圈、针法与打样参数需工厂另核。 |
| [pattern-craft-04-new](quality-matrix/visual-v1/pattern-craft-04-new-831d2905-d8dd-44dd-a16a-34b0d55a7ab6-1.png) | PASS | 六瓣花、五个花心圆点与暖色关系完整。 表面胶印膜层有轻微光泽，棉织物基底可见；未改成刺绣。 | 无需概念级返修；打样时另核胶浆厚度、牢度和真实布料。 |
| [pattern-craft-04-old](quality-matrix/visual-v1/pattern-craft-04-old-5d1310cb-6f6e-4cf9-94ee-9260a6492489-1.png) | PASS | 六瓣花、五个花心圆点与暖色关系完整。 表面胶印膜层有轻微光泽，棉织物基底可见；未改成刺绣。 | 无需概念级返修；打样时另核胶浆厚度、牢度和真实布料。 |
| [pattern-craft-05-new](quality-matrix/visual-v1/pattern-craft-05-new-b71a14fa-68fd-4a4b-bf6f-1ef82627bc65-1.png) | PASS | 四叶枝、深绿外轮廓及浅绿内部保持。 绣线方向与独立织物底面有区分，奶油色针织底面可见。 | 无需概念级返修；线材、密度和针织防变形需工厂打样。 |
| [pattern-craft-05-old](quality-matrix/visual-v1/pattern-craft-05-old-de16104a-3544-48ab-9880-6ea0a3bf173c-1.png) | PASS | 四叶枝、深绿外轮廓及浅绿内部保持。 绣线方向与独立织物底面有区分，奶油色针织底面可见。 | 无需概念级返修；线材、密度和针织防变形需工厂打样。 |
| [pattern-craft-06-new](quality-matrix/visual-v1/pattern-craft-06-new-acdf2815-9665-4b16-82bb-4201f1db47fe-1.png) | PASS | 原几何色区可辨，表现为交织经纬/提花式织物。 粗织帆布观感成立，没有误变成刺绣贴片。 | 无需概念级返修；真实提花组织和帆布克重必须另行工艺确认。 |
| [pattern-craft-06-old](quality-matrix/visual-v1/pattern-craft-06-old-9d31bbc1-feed-4f70-8737-4499f9408b5d-1.png) | PASS | 原几何色区可辨，表现为交织经纬/提花式织物。 粗织帆布观感成立，没有误变成刺绣贴片。 | 无需概念级返修；真实提花组织和帆布克重必须另行工艺确认。 |
| [pattern-craft-07-new](quality-matrix/visual-v1/pattern-craft-07-new-09ffc644-e7cc-4bf6-871b-03bf03a5cf93-1.png) | MINOR REVISION | 每片花瓣内原有的棕色细线消失，不能只靠绒圈纹理代替。 | 保留毛巾绣主体，在六片花瓣内补回原棕色细线关系；不添加新装饰。 |
| [pattern-craft-07-old](quality-matrix/visual-v1/pattern-craft-07-old-af5c6ad7-3223-4aef-9ded-1955ff8b538f-1.png) | MINOR REVISION | 每片花瓣内原有的棕色细线消失，不能只靠绒圈纹理代替。 | 保留毛巾绣主体，在六片花瓣内补回原棕色细线关系；不添加新装饰。 |
| [pattern-craft-08-new](quality-matrix/visual-v1/pattern-craft-08-new-9b2e7a10-4a16-4189-a884-2e76eee456cc-1.png) | PASS | 四叶、深绿外轮廓与叶脉全部保留。 有胶印膜层和针织底面区分，未变绣线。 | 无需概念级返修；胶层厚度、弹性和牢度另需实测。 |
| [pattern-craft-08-old](quality-matrix/visual-v1/pattern-craft-08-old-fe328ed1-6be9-4d2c-aa22-fa6fa44bb6d7-1.png) | MINOR REVISION | 源图深绿色外围轮廓大部分丢失，仅留下内部叶脉。 | 在胶印色层里保留原外轮廓，不能因工艺模拟而删除色区。 |
| [pattern-craft-09-new](quality-matrix/visual-v1/pattern-craft-09-new-e3376ea9-5c0c-4831-a008-410823bbc95c-1.png) | PASS | 原四色几何条带可辨；绣线方向与凸起层次清晰。 底布是粗织帆布观感，与表面刺绣可区分。 | 无需概念级返修；实际针法、边界密度和生产绣花文件不由此图证明。 |
| [pattern-craft-09-old](quality-matrix/visual-v1/pattern-craft-09-old-4fc4bd11-5ae9-4fcc-8d33-8937324c2e3d-1.png) | PASS | 原四色几何条带可辨；绣线方向与凸起层次清晰。 底布是粗织帆布观感，与表面刺绣可区分。 | 无需概念级返修；实际针法、边界密度和生产绣花文件不由此图证明。 |
| [pattern-craft-10-new](quality-matrix/visual-v1/pattern-craft-10-new-316c1f34-8a3b-45f6-a1e2-aaa78277ad75-1.png) | REDO | 斜视近景裁掉右下花瓣边缘，无法交付完整原图案或核对其外形。 | 保留完整六瓣花在画内并留边，取消过近裁切；织物视角不能牺牲原图案完整性。 |
| [pattern-craft-10-old](quality-matrix/visual-v1/pattern-craft-10-old-c603290c-a9c1-4fb7-950a-cc1de8a5bd78-1.png) | PASS | 六瓣、五点花心和花瓣细线完整。 织造纹理穿过色区，提花棉布观感成立。 | 无需概念级视觉返修；织造组织和真实材料参数另核。 |
| [pattern-extract-01-new](quality-matrix/visual-v1/pattern-extract-01-new-0d696194-7404-4ab8-9a7a-891402aa1347-1.png) | STOP AND DIAGNOSE | 保留底色要求未满足：原透明区域被黑色烘焙。 实际RGBA全不透明；同组两次均丢失alpha。 | 先查供应商透明输出支持及上传/保存是否摊平alpha，再从原始透明图恢复RGBA交付；不要以失败输出作参考。 |
| [pattern-extract-01-old](quality-matrix/visual-v1/pattern-extract-01-old-5ead785b-f001-4665-b4e5-bf4971aa444c-1.png) | STOP AND DIAGNOSE | 保留底色要求未满足：原透明区域被白色烘焙。 实际RGBA全不透明；同组两次均丢失alpha。 | 先查供应商透明输出支持及上传/保存是否摊平alpha，再从原始透明图恢复RGBA交付；不要以失败输出作参考。 |
| [pattern-extract-02-new](quality-matrix/visual-v1/pattern-extract-02-new-1c703f88-4a19-492e-92df-134261ee002c-1.png) | PASS | 四片叶、单茎及不对称排列保持，白底符合当前字段。 没有新增花朵、叶片、服装轮廓或自动循环。 | 无需视觉返修；这是一张白底栅格图，不代表矢量或无缝循环。 |
| [pattern-extract-02-old](quality-matrix/visual-v1/pattern-extract-02-old-dff0361b-5e79-44e0-8d53-183a22acfa35-1.png) | PASS | 四片叶、单茎及不对称排列保持，白底符合当前字段。 没有新增花朵、叶片、服装轮廓或自动循环。 | 无需视觉返修；这是一张白底栅格图，不代表矢量或无缝循环。 |
| [pattern-extract-03-new](quality-matrix/visual-v1/pattern-extract-03-new-11ada841-e100-47ee-a423-b425f7c8a29d-1.png) | REDO | 将参考中的相邻几何关系重组为完整八向雪花状图案，顶部/底部闭合菱形及内部白色形状与源可见图形不一致。 明显针织立体纹理保留，提取结果仍像新工艺徽章而非忠实图案整理。 | 只分离指定可见单元，不把邻接纹样拼成完整对称新图案；不新增被裁切或不可见的连接。 |
| [pattern-extract-03-old](quality-matrix/visual-v1/pattern-extract-03-old-577514a0-0b01-4a97-b82c-0d5950b08894-1.png) | REDO | 要求“单独图案”，结果保留整幅多行重复带状布局而非单一元素。 部分边界重复和几何小形被重新绘制，不是原图逐元素提取。 | 明确只选原图中央清晰可见的单一几何单元，保持其实际边界；不补整条循环带、不扩展被裁切元素。 |
| [pattern-extract-04-new](quality-matrix/visual-v1/pattern-extract-04-new-4b8803e7-f5d5-4335-adb9-1d1eec0c1cde-1.png) | STOP AND DIAGNOSE | 源图透明底被改成不透明黑底。 | 隔离此输出，不作新参考；核实图像模型与资产管线的真实 alpha 支持，再用原始透明源图修复输出契约。 |
| [pattern-extract-04-old](quality-matrix/visual-v1/pattern-extract-04-old-e72da686-fedb-4c8a-9f2d-6d14713ada48-1.png) | STOP AND DIAGNOSE | 源图透明底被改成不透明黑底。 | 隔离此输出，不作新参考；核实图像模型与资产管线的真实 alpha 支持，再用原始透明源图修复输出契约。 |
| [pattern-extract-05-new](quality-matrix/visual-v1/pattern-extract-05-new-616b980c-fc69-4c8e-8308-a4786e5bba79-1.png) | MINOR REVISION | 原清晰平滑线边被重绘为颗粒/毛边，提取质量下降。 | 从原始图案保留轮廓与细线；只清底，不引入笔触和毛边。 |
| [pattern-extract-05-old](quality-matrix/visual-v1/pattern-extract-05-old-5788c1b5-2ac7-4554-8cbe-d0b85aa326ed-1.png) | PASS | 四叶枝、非对称连接、深绿轮廓和白底均满足要求。 边缘清晰完整，无额外图案。 | 无需概念级视觉返修。 |
| [pattern-extract-06-new](quality-matrix/visual-v1/pattern-extract-06-new-46382f63-32ba-4232-9d54-c403942d983b-1.png) | REDO | 中央黄色交点被深蓝点和重排的红色菱形取代，改变了原可见图案的相对位置与组合。 把完整可见图案提取变成重建相似重复纹样。 | 按原可见裁片逐区保留位置关系，禁止推断重排循环；不确定边界保留裁切。 |
| [pattern-extract-06-old](quality-matrix/visual-v1/pattern-extract-06-old-40593b25-b17f-42da-9986-f5beb2a59de6-1.png) | MINOR REVISION | 保留大量针织针目肌理，未完全成为清晰平面图案；边界几何存在局部重绘。 | 保留原可见版面，不扩展不可见循环；去除材质肌理并核对几何边界。 |
| [pattern-extract-07-new](quality-matrix/visual-v1/pattern-extract-07-new-ff8de2b4-3d58-4daa-b70e-448c419d7a4a-1.png) | STOP AND DIAGNOSE | 原透明底再次变不透明黑底。 | 隔离结果；核实 alpha 通道管线后从原透明源图修复，禁止继续以失败图作参考。 |
| [pattern-extract-07-old](quality-matrix/visual-v1/pattern-extract-07-old-8dc418b8-ff1a-400f-84c5-fecd1f2827b6-1.png) | STOP AND DIAGNOSE | 原透明底再次变不透明白底。 | 隔离结果；核实 alpha 通道管线后从原透明源图修复，禁止继续以失败图作参考。 |
| [pattern-extract-08-new](quality-matrix/visual-v1/pattern-extract-08-new-7ecb11f1-6529-472e-8d13-d141aa888b8b-1.png) | PASS | 四叶、弯曲枝茎、深绿细线及白底正确。 保持非对称叶序，没有新增叶或重复纹样。 | 无需概念级视觉返修；需要生产级精确路径时仍应沿原图描摹核对。 |
| [pattern-extract-08-old](quality-matrix/visual-v1/pattern-extract-08-old-231b83d8-bf37-4631-becd-fe5278720212-1.png) | PASS | 四叶、弯曲枝茎、深绿细线及白底正确。 保持非对称叶序，没有新增叶或重复纹样。 | 无需概念级视觉返修；需要生产级精确路径时仍应沿原图描摹核对。 |
| [pattern-extract-09-new](quality-matrix/visual-v1/pattern-extract-09-new-af75c3de-a4f1-4c62-8c21-6582ac8d7fc2-1.png) | STOP AND DIAGNOSE | 重建了来源中没有完整出现的八向雪花状单元，并新增中央白色小菱形与周边补全。 重复 03 的推断补全，并非忠实单独图案提取。 | 隔离重建图；回到原可见裁片，明确仅提取真实可见单元，不补不可见循环或重组邻近部件。 |
| [pattern-extract-09-old](quality-matrix/visual-v1/pattern-extract-09-old-9ba86d6d-f202-4591-965d-8b883dad8f0d-1.png) | STOP AND DIAGNOSE | 再次忽略单独图案模式，输出整幅多条带重复纹样；与 03 重复。 | 先定义要提取的原可见单元，禁止整幅重复重绘；不确定单元须保持证据边界。 |
| [pattern-extract-10-new](quality-matrix/visual-v1/pattern-extract-10-new-898aa98e-1022-491f-9a44-d41418d39bb1-1.png) | STOP AND DIAGNOSE | 透明来源再次变不透明黑底。 | 不重复盲重试；从原透明源图解决模型输出/资产管线的 alpha 契约，失败结果隔离。 |
| [pattern-extract-10-old](quality-matrix/visual-v1/pattern-extract-10-old-3298298c-a274-4384-b48b-8ff609e2866e-1.png) | STOP AND DIAGNOSE | 透明来源再次变不透明黑底。 | 不重复盲重试；从原透明源图解决模型输出/资产管线的 alpha 契约，失败结果隔离。 |

## 限制

- 输出是生成提案，不是实物、尺寸、工艺文件或生产证明。
- 透明失败以像素 alpha 检查为准，不把黑底或棋盘格外观当成透明。
- 白底提取与工艺面料背景本来允许不透明，不混入透明拒收统计。
- 低分辨率针织裁片不能证明隐藏重复单元或逐针恢复；禁止把补全图变成原始证据。
- 随机对照未绑定相同 seed；此批不支持统计显著或总体胜率结论。
- 10 对/场景并非 10 个独立业务意图，重复输入组如下：

- back-design-01、back-design-05
- pattern-extract-01、pattern-extract-07
- pattern-colorway-01、pattern-colorway-07
- pattern-extract-02、pattern-extract-08
- pattern-extract-03、pattern-extract-09
- pattern-colorway-03、pattern-colorway-09
- accessory-design-03、accessory-design-05、accessory-design-09
- pattern-extract-04、pattern-extract-10
- pattern-colorway-04、pattern-colorway-10
- accessory-design-04、accessory-design-10
- back-design-06、back-design-10
- accessory-design-06、accessory-design-08
