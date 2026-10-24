# 首四场景逐图视觉验收

审核范围：visual-v1；ledger 快照 2026-10-24T17:46:51.894Z。80 项中 78 张成功结果全部实看并核对 SHA-256；2 项提示词扩写失败无图，不伪造视觉结论。审阅者付费调用：0。

总判定：PASS 39；MINOR REVISION 17；REDO 17；STOP AND DIAGNOSE 5。

## 结论

不能宣称新版全面更优。新版在部分参考色职责与局部结构上更接近需求，但出现多扣、禁止区域换色、保留扣色失败、把新增改成替换等回退。相对胜出不等于通过。协议成功不等于视觉验收通过。

| 场景 | 已审 / 应有 | 完整组 | 新胜 / 旧胜 / 平 / UNKNOWN |
|---|---:|---:|---|
| text-to-style | 20/20 | 10/10 | 0 / 0 / 9 / 1 |
| style-to-sketch | 18/20 | 8/10 | 未齐 10 组，不发布场景胜平负 |
| local-restyle | 20/20 | 10/10 | 4 / 1 / 5 / 0 |
| garment-colorway | 20/20 | 10/10 | 4 / 4 / 2 / 0 |

每组仅一个 old/new 样本，未作显著性分析；平局可以是两图都合格，也可以是同样失败。

## 关键证据与样本限制

- 线稿01/03/05的‘实际可见五颗’没有说明领口部分可见扣是否计入；源图有5颗完整门襟扣+领口扣，相关项停止判定而非假PASS。
- text-to-style-09‘粉蓝’可能是粉蓝色或粉+蓝双色，颜色需求未消歧。
- local-restyle-05源图本已弧形下摆，不能证明从直改弧的能力。
- local-restyle-08源图已有左胸袋，按‘增加一只’字面应保留原袋再新增；新版prompt直接写replace existing，是需求动作漂移。若业务意图是总数1，须先澄清源需求。
- 无真实mask的这批局部改款仅视觉核对，未验证编辑区外逐像素一致；补测mask不属于本报告。
- 生成图单次结果、重复源素材和有限样本不能支持新版全面更优的结论。
- text-to-style-01 两版都是领口1颗+门襟5颗，共6颗；纯文字明确要求5颗，无源图歧义，均 REDO。
- style-to-sketch-09-new 新增最下方门襟扣，完整门襟6颗+领口1颗；源图为5+1，属于明确多扣。
- garment-colorway-08-new 将要求保留原色的袖子也染粉；局部范围失败。
- 多个 flat 换色结果把无纹理平涂示意图写实织物化；不能因‘更真实’判通过。

## 缺图及恢复记录

- style-to-sketch-01-new、style-to-sketch-02-new：failed / PROMPT_OUTPUT_INVALID，无结果图，不计视觉失败、不重试。
- local-restyle-07-old：曾因原结果下载瞬时 TLS 失败暂停；主 Agent 按原上游任务 task_01M5QFD4ARY5SY4XJXW1B1W6S6 恢复下载，无新增生成。本报告已补看恢复文件并核对其 SHA-256。

## 成对比较

| Pair | old | new | 更符合需求 | 依据 |
|---|---|---|---|---|
| text-to-style-01 | [REDO](<quality-matrix/visual-v1/text-to-style-01-old-3864d888-1ce2-496a-9847-29613eb0e91b-1.png>) | [REDO](<quality-matrix/visual-v1/text-to-style-01-new-62146bde-a49d-4618-876b-059fa373046e-1.png>) | TIE | 两版均违反明确纽扣计数，不能以轮廓或面料观感决定合格。 |
| text-to-style-02 | [PASS](<quality-matrix/visual-v1/text-to-style-02-old-f0e66795-8371-4e96-9b6c-3f43568a62dd-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-02-new-5be43d3d-8c67-4faa-b1a2-8ac62270642b-1.png>) | TIE | 两版均满足可见结构、无袋及INCHOICE原文要求；字的大小/深浅没有可判定的额外硬约束。 |
| text-to-style-03 | [PASS](<quality-matrix/visual-v1/text-to-style-03-old-9116eccf-04e2-431c-b136-9afef341ee87-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-03-new-c95fe776-21c0-42ce-9369-d6bef5f82b0b-1.png>) | TIE | 均满足V领、无袖、海军蓝、合体及简洁罗纹下摆；无结构性优劣证据。 |
| text-to-style-04 | [PASS](<quality-matrix/visual-v1/text-to-style-04-old-841a3544-6edf-4e6a-a994-9a0968a30be2-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-04-new-39cd644f-241b-4d11-9e49-a12d669c5702-1.png>) | TIE | 两版均为短款宽松翻领夹克和两只贴袋；袋盖与袋位置未被指定，不把该开放选择当错误。色名无色卡，不以偏好判胜。 |
| text-to-style-05 | [PASS](<quality-matrix/visual-v1/text-to-style-05-old-7ff31a5b-d91e-49c8-90c2-141135623bbe-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-05-new-e23238b2-8f10-41a5-88a7-132cde685191-1.png>) | TIE | 两版均满足可见圆领、长袖、收腰和A字浅蓝外观；实际及膝丈长在无尺度平铺中同为UNKNOWN。袖口褶量不是锁定条件。 |
| text-to-style-06 | [PASS](<quality-matrix/visual-v1/text-to-style-06-old-e2bda2a9-5b16-4acf-be37-66cb392f781a-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-06-new-bef1f40d-b510-43bb-b964-baed9db41119-1.png>) | TIE | 两版都实现砖红、落肩、宽松圆领套头和无抽绳；不按更饱满的袖形或阴影评分。 |
| text-to-style-07 | [PASS](<quality-matrix/visual-v1/text-to-style-07-old-a43d2b95-853e-4fe8-a74c-6d7a888c3965-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-07-new-d2e7103f-b9c5-41d0-9226-85376df385c1-1.png>) | TIE | 两版都满足米白、宽腿、长裤、松紧腰、亚麻感和无印花；没有可见硬项优势。 |
| text-to-style-08 | [PASS](<quality-matrix/visual-v1/text-to-style-08-old-64a2c177-d035-4116-a515-2db72654a33b-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-08-new-ae79a0dd-86ae-4d1d-a4ea-42fae16eef8a-1.png>) | TIE | 两版均为深灰哑光无袋直筒裙且单侧短开衩；实际膝位没有尺度，均保留UNKNOWN。 |
| text-to-style-09 | [MINOR REVISION](<quality-matrix/visual-v1/text-to-style-09-old-c10d01e1-4549-4ba1-a845-1948ee7b86f8-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/text-to-style-09-new-d14507d1-24b8-441c-8c05-e1c742e78b4a-1.png>) | UNKNOWN | 旧图粉红+浅蓝+白，新图粉蓝色+白；原文‘粉蓝’存在实质颜色歧义，不能用审阅者偏好决胜。结构项持平。 |
| text-to-style-10 | [PASS](<quality-matrix/visual-v1/text-to-style-10-old-cbf533ed-02da-4a83-a665-f25a545e39c7-1.png>) | [PASS](<quality-matrix/visual-v1/text-to-style-10-new-5317565c-aa44-424e-93cd-722cb098f9a8-1.png>) | TIE | 两版均满足奶油黄圆领长袖针织开衫和前中纽扣要求；不得从另一案例借用固定纽扣数。 |
| style-to-sketch-01 | [STOP AND DIAGNOSE](<quality-matrix/visual-v1/style-to-sketch-01-old-e064cc5a-b571-4164-8b03-9d958f370708-1.png>) | 无成功图 / UNKNOWN | UNKNOWN | 新版本没有成功输出，旧版可审但计数基准需澄清，不能进行完整双图比较。 |
| style-to-sketch-02 | [PASS](<quality-matrix/visual-v1/style-to-sketch-02-old-0b1ddc2b-aa82-4ab4-a3f9-079287ee357a-1.png>) | 无成功图 / UNKNOWN | UNKNOWN | 旧版视觉通过，新版没有成功输出；缺图不能当作视觉劣图或计算胜率。 |
| style-to-sketch-03 | [STOP AND DIAGNOSE](<quality-matrix/visual-v1/style-to-sketch-03-old-3f8ad327-fe4e-4ec8-be04-72d6d4cf3695-1.png>) | [STOP AND DIAGNOSE](<quality-matrix/visual-v1/style-to-sketch-03-new-be93d9a1-3bfa-4b10-9fa8-261317bbcd71-1.png>) | UNKNOWN | 两版都保留源图5颗完整门襟扣及部分可见领口扣；五颗的总数口径未统一，结构项相当但不能假PASS。 |
| style-to-sketch-04 | [PASS](<quality-matrix/visual-v1/style-to-sketch-04-old-61b2a5c9-adea-4f8d-9b0a-4508b5f0ef19-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/style-to-sketch-04-new-62bdf7e9-410f-4d1c-9780-8f033a306bfb-1.png>) | OLD | 旧版保留实际轮廓；新版补出源图未显示的袋缝虚线及扣孔，不能以更详细作为更忠实。 |
| style-to-sketch-05 | [STOP AND DIAGNOSE](<quality-matrix/visual-v1/style-to-sketch-05-old-1fa3d30f-c19c-477a-b1ef-094caab6f397-1.png>) | [STOP AND DIAGNOSE](<quality-matrix/visual-v1/style-to-sketch-05-new-c8daa9b8-40d2-49c6-8012-218306b39286-1.png>) | UNKNOWN | 旧版保留源图领口小扣，新版删去后总数5；计数口径与源图保留要求存在冲突。 |
| style-to-sketch-06 | [PASS](<quality-matrix/visual-v1/style-to-sketch-06-old-59bae8f1-0931-485c-83c7-9e69ccad359b-1.png>) | [PASS](<quality-matrix/visual-v1/style-to-sketch-06-new-776f57cd-d81a-4c4e-a994-e4a6e4789b28-1.png>) | TIE | 两版均完成极简转换并保留主要实际可见结构，无不相关细节新增。 |
| style-to-sketch-07 | [PASS](<quality-matrix/visual-v1/style-to-sketch-07-old-7e6f7322-fa5a-4a9e-8655-cfe70a01d5cd-1.png>) | [PASS](<quality-matrix/visual-v1/style-to-sketch-07-new-9320450b-a7a4-4ff8-88aa-bf348cc69ba2-1.png>) | TIE | 两版均保留实际可见结构和领口小扣；线条粗细或虚实风格不足以判定需求优劣。 |
| style-to-sketch-08 | [PASS](<quality-matrix/visual-v1/style-to-sketch-08-old-c867cd15-81dc-44d5-9765-d7d9634719c2-1.png>) | [PASS](<quality-matrix/visual-v1/style-to-sketch-08-new-eeb227cd-05b9-4b11-992b-538055ca15cd-1.png>) | TIE | 两版均保留极简可见结构，不以转角圆润程度作为硬性优劣。 |
| style-to-sketch-09 | [PASS](<quality-matrix/visual-v1/style-to-sketch-09-old-423f9f9b-650c-4b96-ae7f-edc92714b4e7-1.png>) | [REDO](<quality-matrix/visual-v1/style-to-sketch-09-new-390182b5-ed06-429e-bc4b-eb3fb2fc60e5-1.png>) | OLD | 新版新增1颗完整门襟扣（6颗门襟+领口），旧版保留源图5颗门襟+领口；这里不是计数口径歧义。 |
| style-to-sketch-10 | [PASS](<quality-matrix/visual-v1/style-to-sketch-10-old-21d64d4d-449d-4b87-8799-7a23e39b7aee-1.png>) | [PASS](<quality-matrix/visual-v1/style-to-sketch-10-new-25ec4a26-c6e4-43e1-abf8-653e41172b97-1.png>) | TIE | 两版均保留实际可见极简结构，无明显硬项优劣。 |
| local-restyle-01 | [PASS](<quality-matrix/visual-v1/local-restyle-01-old-a8cc8140-4826-4c64-80fb-d18c9b48a4da-1.png>) | [PASS](<quality-matrix/visual-v1/local-restyle-01-new-af10024a-e849-4322-ac42-40f96bad1a65-1.png>) | TIE | 两版均完成无花边圆角领并在视觉层面保留衣身；无像素级不变证据。 |
| local-restyle-02 | [REDO](<quality-matrix/visual-v1/local-restyle-02-old-d81719ce-4409-4f86-a1e0-a717fab2ed52-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-02-new-2d56080b-2a39-47d3-b06f-52388e1a8289-1.png>) | NEW | 新版保留原角形扣且袖端更贴近原位置；旧版明显缩袖并改扣形。新版仍有轻微平涂/边缘漂移，不是无条件PASS。 |
| local-restyle-03 | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-03-old-92386f1d-ef30-4291-b318-30ec50640064-1.png>) | [PASS](<quality-matrix/visual-v1/local-restyle-03-new-dc138755-f3ca-488e-835a-788b5a5b03a8-1.png>) | NEW | 新版实现明确的方形贴袋，旧版袋底收尖；不能以旧版更像常见衬衫口袋替代原需求。 |
| local-restyle-04 | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-04-old-220341cd-c009-4645-bb04-09fd0c2ed8e0-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-04-new-b6d8546c-4233-43dd-b973-1398965d3403-1.png>) | TIE | 两版均换成深棕圆扣且均有非按钮区域轻微平涂漂移，不能据线条平滑度判胜。 |
| local-restyle-05 | [PASS](<quality-matrix/visual-v1/local-restyle-05-old-5d755491-f3ff-43b1-bc29-77c4d5abe4ad-1.png>) | [PASS](<quality-matrix/visual-v1/local-restyle-05-new-c8520541-2bcc-4722-a751-08b796748669-1.png>) | TIE | 两版结果均为浅弧形；源图原本也是弧形，无法证明案例声称的直改弧能力。 |
| local-restyle-06 | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-06-old-7a34dece-14d4-472f-a50d-cc459528a42f-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-06-new-f51c2c53-73e1-451e-8723-483aa638e412-1.png>) | NEW | 新版保持原角形扣，旧版未授权改圆扣；新版仍存在平涂细微漂移。 |
| local-restyle-07 | [PASS](<quality-matrix/visual-v1/local-restyle-07-old-8e2b1628-5cf9-4794-8b61-1a886c31069a-1.png>) | [PASS](<quality-matrix/visual-v1/local-restyle-07-new-23d43cca-7a49-4955-ad94-0860d696b19a-1.png>) | TIE | 两版均增加窄折边并基本保留结构；旧版已从原上游任务恢复下载，不能将下载瞬时失败当视觉劣势。 |
| local-restyle-08 | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-08-old-6fb795b5-b2cd-4c38-bd52-4edf959a6710-1.png>) | [REDO](<quality-matrix/visual-v1/local-restyle-08-new-469db16c-ad79-4ce9-a69c-8d971851c200-1.png>) | OLD | 按原文‘增加一只’并保留未指定部位，旧版确实保留原袋再新增；新版仅改原袋。源图已有袋构成业务歧义，若用户意在总数1需先更正基准，不追溯偏好选新版。 |
| local-restyle-09 | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-09-old-c8351942-b9bc-4eea-89d3-eb5690e814e7-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-09-new-a3102156-9e74-4035-8593-374d2a35eb00-1.png>) | TIE | 两版均完成5颗门襟扣而漏掉部分可见领口扣，均需补正；没有明确胜负。 |
| local-restyle-10 | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-10-old-27a8c82a-cc86-4431-8e5a-08feaf232b0c-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/local-restyle-10-new-af5e5659-8f30-4049-9170-5d38c3da8149-1.png>) | NEW | 新版保留原角形扣，旧版改圆扣；两者下摆目标均实现，新版仍有平涂漂移。 |
| garment-colorway-01 | [PASS](<quality-matrix/visual-v1/garment-colorway-01-old-4e2f19d7-dfe0-4f02-94c2-50107c4a1f3d-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/garment-colorway-01-new-4c759a2c-6763-463a-9a46-dad583326c1c-1.png>) | OLD | 旧版保持浅蓝原扣色，新版扣色变灰白；智能配色中的米色领本身是允许选择，不据此扣分。 |
| garment-colorway-02 | [REDO](<quality-matrix/visual-v1/garment-colorway-02-old-3dabae36-e706-4a10-b552-0ac8f406aef5-1.png>) | [REDO](<quality-matrix/visual-v1/garment-colorway-02-new-ac190386-1fda-4e62-a51f-8b53d7e25bda-1.png>) | TIE | 两版都把纯平涂素材织物化且改角形扣为圆形，均违反只换色与保纹理/纽扣条件；配色相符不抵消该缺陷。 |
| garment-colorway-03 | [REDO](<quality-matrix/visual-v1/garment-colorway-03-old-09a8ec88-f50e-4fed-8dfd-0c005f75a333-1.png>) | [PASS](<quality-matrix/visual-v1/garment-colorway-03-new-ae22654c-f175-425e-a900-6bf2f2e6010e-1.png>) | NEW | 新版只迁移色族；旧版复制了针织纹样和材质，参考图职责明确失守。 |
| garment-colorway-04 | [REDO](<quality-matrix/visual-v1/garment-colorway-04-old-a46c2098-6eed-4c2b-8622-92d5fbc60206-1.png>) | [REDO](<quality-matrix/visual-v1/garment-colorway-04-new-f9c5faf2-fb54-43b9-ac0c-b94ffd8358fd-1.png>) | OLD | 两版均因新增织物纹理需要重做，但旧版另保留原角形扣，新版还改变扣形；旧版仅相对更贴近，不等于通过。 |
| garment-colorway-05 | [MINOR REVISION](<quality-matrix/visual-v1/garment-colorway-05-old-d001b150-f769-4d16-8b0e-e1c2b2bf0316-1.png>) | [PASS](<quality-matrix/visual-v1/garment-colorway-05-new-d4293494-61a7-4b87-a597-dfeb0a4a86ed-1.png>) | NEW | 新版落实指定绿+米双色，旧版只用绿色；不按配色美感选择。 |
| garment-colorway-06 | [REDO](<quality-matrix/visual-v1/garment-colorway-06-old-b5d6a3fe-f8f3-48fa-a100-fa8fc6e2464c-1.png>) | [REDO](<quality-matrix/visual-v1/garment-colorway-06-new-8d79f115-9b2e-496b-9950-9e9bc172e558-1.png>) | NEW | 两版都因复制针织纹样/材质REDO；新版至少保留米白领色，旧版把领片也改为米棕。仅是相对较少越界，不是合格提升。 |
| garment-colorway-07 | [PASS](<quality-matrix/visual-v1/garment-colorway-07-old-5a868e68-720b-4d50-83a9-d2dcdf81e009-1.png>) | [MINOR REVISION](<quality-matrix/visual-v1/garment-colorway-07-new-6ac61651-3b51-4faa-b81f-9502d0829dd6-1.png>) | OLD | 旧版保留浅蓝扣色，新版改为灰绿扣；领面双色选择本身在授权范围。 |
| garment-colorway-08 | [REDO](<quality-matrix/visual-v1/garment-colorway-08-old-2cdeeb21-ad79-437f-a033-b23923f20987-1.png>) | [REDO](<quality-matrix/visual-v1/garment-colorway-08-new-5f84fb47-9617-46ad-8685-bbea37046523-1.png>) | OLD | 新版明确把禁止改色的袖子染粉，旧版保留袖色。两版都存在原平涂变织物的缺陷，旧胜不等于通过。 |
| garment-colorway-09 | [REDO](<quality-matrix/visual-v1/garment-colorway-09-old-0871e75a-a8a8-4f36-847a-dedf59ee7a55-1.png>) | [PASS](<quality-matrix/visual-v1/garment-colorway-09-new-5b226976-99ae-4fb5-be6d-fe0c9f85a5e4-1.png>) | NEW | 新版只取配色色族而不复制纹样，旧版迁移针织图案/材质。 |
| garment-colorway-10 | [REDO](<quality-matrix/visual-v1/garment-colorway-10-old-fedfbb4e-dc48-46fc-8be3-5dae74488fab-1.png>) | [REDO](<quality-matrix/visual-v1/garment-colorway-10-new-f58a6747-d9fb-43fb-bff3-bf41d4a4adc1-1.png>) | TIE | 两版都给纯平涂素材新增织纹且涉及袖子；在这一明确保留约束上均不合格。 |

## 每图证据

以下 PASS 仅是可见概念效果判定，不代表可生产、实物面料成立、精确色差或像素级保持。

### text-to-style-01-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-01-old-3864d888-1ce2-496a-9847-29613eb0e91b-1.png>)

可见证据：奶油色小尖领长袖、无口袋、单款白底平铺可见。 前中可清楚数到6颗纽扣：领口1颗，下方5颗；要求是总计5颗。
失败点：前中纽扣总数6≠5。
未验证：纤维成分和棉府绸实物手感无法由生成图验证。
最小修正方向：从原始文字需求重新约束前中总计恰好5颗（领口计入总数），其余不增加改动；本次不重试。

### text-to-style-01-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-01-new-62146bde-a49d-4618-876b-059fa373046e-1.png>)

可见证据：奶油色小尖领长袖、无口袋、单款白底平铺可见。 前中仍为6颗纽扣：领口1颗，下方5颗；新版提示词强调exactly five也未实现。
失败点：前中纽扣总数6≠5。
未验证：纤维成分和棉府绸实物手感无法由生成图验证。
最小修正方向：诊断计数约束在生图阶段失效，保留此负例；修正后仍须从原始文字需求开始，不使用本失败图作输入。

### text-to-style-02-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-02-old-f0e66795-8371-4e96-9b6c-3f43568a62dd-1.png>)

可见证据：麻灰圆领、直身短袖T恤；无胸袋。 穿着者左胸可读INCHOICE且无其他文字；整件白底平铺。
失败点：未发现明确可见硬项失败。
未验证：只能确认细针织/麻灰视觉表现，不能证明实际棉成分。

### text-to-style-02-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-02-new-5be43d3d-8c67-4faa-b1a2-8ac62270642b-1.png>)

可见证据：麻灰圆领、直身短袖T恤；无胸袋。 穿着者左胸小字INCHOICE可辨，无额外文字；整件白底平铺。
失败点：未发现明确可见硬项失败。
未验证：只能确认细针织/麻灰视觉表现，不能证明实际棉成分。

### text-to-style-03-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-03-old-9116eccf-04e2-431c-b136-9afef341ee87-1.png>)

可见证据：海军蓝V领无袖针织背心；腰部略收，符合合体方向。 下摆清楚呈简洁竖向罗纹，单款完整白底平铺，无额外图文。
失败点：未发现明确可见硬项失败。
未验证：棉成分和实际针距未验证。

### text-to-style-03-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-03-new-c95fe776-21c0-42ce-9369-d6bef5f82b0b-1.png>)

可见证据：海军蓝V领无袖针织背心，轮廓贴合而非宽大型。 简洁罗纹下摆可见；无额外图案文字，完整单款白底。
失败点：未发现明确可见硬项失败。
未验证：棉成分和实际针距未验证。

### text-to-style-04-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-04-old-841a3544-6edf-4e6a-a994-9a0968a30be2-1.png>)

可见证据：灰绿色短身宽松翻领夹克，斜纹视觉可辨。 仅两只贴袋（带袋盖），无额外袋、图文或产品；白底完整平铺。
失败点：未发现明确可见硬项失败。
未验证：未指定色卡，鼠尾草绿只做视觉色族判断；棉成分未验证。

### text-to-style-04-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-04-new-39cd644f-241b-4d11-9e49-a12d669c5702-1.png>)

可见证据：低饱和绿短款宽松翻领夹克，斜向纹理明确。 正面恰有两只无盖贴袋；单款白底完整呈现。
失败点：未发现明确可见硬项失败。
未验证：绿色稍偏黄，但无指定色卡无法作精确色差结论；棉成分未验证。

### text-to-style-05-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-05-old-7ff31a5b-d91e-49c8-90c2-141135623bbe-1.png>)

可见证据：浅蓝长袖、小圆领、腰缝收腰与A字展开裙摆明确。 衣身与袖长比例呈膝长连衣裙方向，单款完整白底；面料有棉麻感细纹。
失败点：未发现明确可见硬项失败。
未验证：无人体/尺寸参照，实际穿着是否准确及膝为UNKNOWN；棉麻成分不能由图证明。

### text-to-style-05-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-05-new-e23238b2-8f10-41a5-88a7-132cde685191-1.png>)

可见证据：浅蓝长袖、小圆领、收腰、A字裙摆可见。 单款前片完整平铺，衣长比例与膝长概念相容；没有额外图文。
失败点：未发现明确可见硬项失败。
未验证：无人体/尺寸参照，实际穿着是否准确及膝为UNKNOWN；棉麻成分不能由图证明。

### text-to-style-06-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-06-old-e2bda2a9-5b16-4acf-be37-66cb392f781a-1.png>)

可见证据：砖红圆领套头卫衣，袖窿接缝明显下落于肩外。 宽松身形、无抽绳无帽，领口内侧可见毛圈感；整件白底平铺。
失败点：未发现明确可见硬项失败。
未验证：真实毛圈组织和纤维成分未验证。

### text-to-style-06-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-06-new-bef1f40d-b510-43bb-b964-baed9db41119-1.png>)

可见证据：砖红圆领套头卫衣，落肩接缝与宽松袖身明确。 没有抽绳、帽子、口袋或印字，领内毛圈感可见；白底单件完整。
失败点：未发现明确可见硬项失败。
未验证：真实毛圈组织和纤维成分未验证。

### text-to-style-07-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-07-old-a43d2b95-853e-4fe8-a74c-6d7a888c3965-1.png>)

可见证据：米白色长裤、两条宽直裤腿、皱褶松紧腰清楚。 亚麻感细节与无印花要求相符；无额外图文，整件白底平铺。
失败点：未发现明确可见硬项失败。
未验证：实际纤维成分与穿着裤长未验证。

### text-to-style-07-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-07-new-d2e7103f-b9c5-41d0-9226-85376df385c1-1.png>)

可见证据：米白阔腿长裤，完整松紧腰与宽大裤脚；无印花。 可见亚麻感天然纹理，单款白底正面平铺。
失败点：未发现明确可见硬项失败。
未验证：实际纤维成分与穿着裤长未验证。

### text-to-style-08-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-08-old-64a2c177-d035-4116-a515-2db72654a33b-1.png>)

可见证据：深灰无袋直筒半裙、哑光梭织外观；没有印花或文字。 画面右侧下摆可见单一短开衩，单件平铺完整。
失败点：未发现明确可见硬项失败。
未验证：无身高/丈长尺度，实际及膝位置为UNKNOWN；不可作为实测尺码验收。

### text-to-style-08-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-08-new-ae79a0dd-86ae-4d1d-a4ea-42fae16eef8a-1.png>)

可见证据：深灰色直筒半裙、哑光面料，无可见口袋。 仅一侧下摆小开衩，完整白底单款，没有额外部件或标字。
失败点：未发现明确可见硬项失败。
未验证：无身高/丈长尺度，实际及膝位置为UNKNOWN；不可作为实测尺码验收。

### text-to-style-09-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-09-old-c10d01e1-4549-4ba1-a845-1948ee7b86f8-1.png>)

可见证据：开领短袖箱型衬衫，直下摆、白底平铺可见。 条纹同时含粉红、浅蓝和白；与新版的纯粉蓝/白条纹不同。
失败点：需求‘粉蓝条纹’的颜色语义未消歧；不能确认额外粉红条纹被授权，也不能武断认定其必错。
未验证：颜色要求的确切语义为UNKNOWN；实际棉成分未验证。
最小修正方向：先明确‘粉蓝’是粉蓝色（powder blue）还是粉色加蓝色双色；保留本图，不为澄清追加生成。

### text-to-style-09-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-09-new-d14507d1-24b8-441c-8c05-e1c742e78b4a-1.png>)

可见证据：开领短袖、箱型轮廓和直下摆明确，整件白底。 条纹为粉蓝色与白色，未见粉红条纹。
失败点：需求‘粉蓝条纹’的颜色语义未消歧；若指粉蓝色则此版相符，若指粉红加蓝双色则缺粉红。
未验证：颜色要求的确切语义为UNKNOWN；实际棉成分未验证。
最小修正方向：将原需求色名消歧后再作最终颜色验收，不把当前生成图当作新的需求证据。

### text-to-style-10-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-10-old-cbf533ed-02da-4a83-a665-f25a545e39c7-1.png>)

可见证据：奶油黄圆领长袖针织开衫，前中完整纽扣开襟。 微宽松身形、细针织感和罗纹收边明确；单件白底，无额外图文。
失败点：未发现明确可见硬项失败。
未验证：实际纤维成分、针距和尺寸未验证；此例未指定纽扣数量，不能套用第1例的五颗条件。

### text-to-style-10-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/text-to-style-10-new-5317565c-aa44-424e-93cd-722cb098f9a8-1.png>)

可见证据：奶油黄圆领长袖开衫，前中纽扣、细针织面和微宽松轮廓可见。 白底完整单款；没有口袋、图文或其他产品。
失败点：未发现明确可见硬项失败。
未验证：实际纤维成分、针距和尺寸未验证；此例未指定纽扣数量。

### style-to-sketch-01-old — STOP AND DIAGNOSE

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-01-old-e064cc5a-b571-4164-8b03-9d958f370708-1.png>)

可见证据：正面黑白线稿、尖领、短袖、无袋与弧形下摆保留；没有填色、无关文字或标尺。 可见5颗完整门襟扣，领口处另有1颗扣；源图同样有5颗完整门襟扣及1颗部分可见领口扣。
失败点：五颗的文字计数与源图领口扣的计入规则未统一；既不能将总计6颗判为满足字面五颗，也不能称其第6颗凭空新增。
未验证：纽扣计数口径UNKNOWN；栅格线稿并非生产纸样、可编辑矢量或实测技术稿。
最小修正方向：先明确五颗是门襟完整扣数还是含领口的总数，再核对源图与基准；不依据生成图反改原始需求，不追加生成。

### style-to-sketch-02-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-02-old-0b1ddc2b-aa82-4ab4-a3f9-079287ee357a-1.png>)

可见证据：白底极简黑线正面，恰好5颗门襟扣、原有单胸袋保留。 尖领、短袖、直下摆和源图主要轮廓保持；没有新增袋、装饰、色块或尺寸文字。
失败点：未发现明确可见硬项失败。
未验证：未做图像配准，不能宣称比例逐点完全一致；栅格概念线稿不代表可编辑矢量或生产纸样。

### style-to-sketch-03-old — STOP AND DIAGNOSE

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-03-old-3f8ad327-fe4e-4ec8-be04-72d6d4cf3695-1.png>)

可见证据：正面黑白线稿、尖领、短袖、无袋与弧形下摆保留；没有填色、无关文字或标尺。 可见5颗完整门襟扣，领口处另有1颗扣；源图同样有5颗完整门襟扣及1颗部分可见领口扣。
失败点：五颗的文字计数与源图领口扣的计入规则未统一；既不能将总计6颗判为满足字面五颗，也不能称其第6颗凭空新增。
未验证：纽扣计数口径UNKNOWN；栅格线稿并非生产纸样、可编辑矢量或实测技术稿。
最小修正方向：先明确五颗是门襟完整扣数还是含领口的总数，再核对源图与基准；不依据生成图反改原始需求，不追加生成。

### style-to-sketch-03-new — STOP AND DIAGNOSE

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-03-new-be93d9a1-3bfa-4b10-9fa8-261317bbcd71-1.png>)

可见证据：正面黑白线稿、尖领、短袖、无袋与弧形下摆保留；没有填色、无关文字或标尺。 可见5颗完整门襟扣，领口处另有1颗扣；源图同样有5颗完整门襟扣及1颗部分可见领口扣。
失败点：五颗的文字计数与源图领口扣的计入规则未统一；既不能将总计6颗判为满足字面五颗，也不能称其第6颗凭空新增。
未验证：纽扣计数口径UNKNOWN；栅格线稿并非生产纸样、可编辑矢量或实测技术稿。
最小修正方向：先明确五颗是门襟完整扣数还是含领口的总数，再核对源图与基准；不依据生成图反改原始需求，不追加生成。

### style-to-sketch-04-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-04-old-61b2a5c9-adea-4f8d-9b0a-4508b5f0ef19-1.png>)

可见证据：白底极简黑线正面，恰好5颗门襟扣、原有单胸袋保留。 尖领、短袖、直下摆和源图主要轮廓保持；没有新增袋、装饰、色块或尺寸文字。
失败点：未发现明确可见硬项失败。
未验证：未做图像配准，不能宣称比例逐点完全一致；栅格概念线稿不代表可编辑矢量或生产纸样。

### style-to-sketch-04-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-04-new-62bdf7e9-410f-4d1c-9780-8f033a306bfb-1.png>)

可见证据：正面极简白底黑线、5颗扣和原有单袋保留。 胸袋周围新增虚线缝迹，纽扣新增两孔；原平涂示意图只画袋轮廓/袋口线和实心角形扣，没有这些可见细节。
失败点：详细级别被当作补全不可见缝线/扣孔的许可。
未验证：不能将新增线迹解释为源图生产证据；栅格线稿非纸样。
最小修正方向：仅描出源图实际可见轮廓与袋口线，去掉推断的缝迹/扣孔。

### style-to-sketch-05-old — STOP AND DIAGNOSE

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-05-old-1fa3d30f-c19c-477a-b1ef-094caab6f397-1.png>)

可见证据：保留5颗完整门襟扣及领口小扣，共可见6处。 无袋短袖尖领与弧形下摆保留，白底黑线无标字。
失败点：原需求‘保留实际可见五颗’与源图5颗门襟完整扣+部分可见领口扣的计数边界不一致。
未验证：计数验收UNKNOWN；没有生产纸样效力。
最小修正方向：统一五颗是否包括领口的口径后，再决定保留或删除源图领口扣，不能凭这组作新旧赢家。

### style-to-sketch-05-new — STOP AND DIAGNOSE

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-05-new-c8daa9b8-40d2-49c6-8012-218306b39286-1.png>)

可见证据：只画5颗完整门襟扣，源图部分可见的领口小扣未画。 无袋短袖尖领与弧形下摆保留，白底黑线无标字。
失败点：原需求‘保留实际可见五颗’与源图5颗门襟完整扣+部分可见领口扣的计数边界不一致。
未验证：计数验收UNKNOWN；没有生产纸样效力。
最小修正方向：统一五颗是否包括领口的口径后，再决定保留或删除源图领口扣，不能凭这组作新旧赢家。

### style-to-sketch-06-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-06-old-59bae8f1-0931-485c-83c7-9e69ccad359b-1.png>)

可见证据：极简黑线保留尖领、短袖、前中5颗扣、单胸袋及直下摆。 未增加不可见缝迹、颜色块、背景物或文字；原单袋未丢失。
失败点：未发现明确可见硬项失败。
未验证：极简抽象会平滑原锯齿/转角，未做几何配准，不等同精确矢量描摹。

### style-to-sketch-06-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-06-new-776f57cd-d81a-4c4e-a994-e4a6e4789b28-1.png>)

可见证据：极简黑线保留尖领、短袖、前中5颗扣、单胸袋及直下摆。 未增加不可见缝迹、颜色块、背景物或文字；原单袋未丢失。
失败点：未发现明确可见硬项失败。
未验证：极简抽象会平滑原锯齿/转角，未做几何配准，不等同精确矢量描摹。

### style-to-sketch-07-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-07-old-7e6f7322-fa5a-4a9e-8655-cfe70a01d5cd-1.png>)

可见证据：尖领、短袖、弧形下摆及原5颗完整门襟扣+部分可见领口扣均有体现，未加袋。 黑白线稿保留领、门襟、肩袖和下摆可见结构；本例未要求总计5颗，不能套用01/03/05的冲突条件。
失败点：未发现明确可见硬项失败。
未验证：线迹为概念表现，实际针距/结构尺寸没有测量；不代表可生产纸样。

### style-to-sketch-07-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-07-new-9320450b-a7a4-4ff8-88aa-bf348cc69ba2-1.png>)

可见证据：尖领、短袖、弧形下摆及原5颗完整门襟扣+部分可见领口扣均有体现，未加袋。 黑白线稿保留领、门襟、肩袖和下摆可见结构；本例未要求总计5颗，不能套用01/03/05的冲突条件。
失败点：未发现明确可见硬项失败。
未验证：线迹为概念表现，实际针距/结构尺寸没有测量；不代表可生产纸样。

### style-to-sketch-08-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-08-old-c867cd15-81dc-44d5-9765-d7d9634719c2-1.png>)

可见证据：极简线稿保留原尖领、短袖、单胸袋、5颗门襟扣及直下摆。 无多余可见缝线、文字、尺寸标注或色块。
失败点：未发现明确可见硬项失败。
未验证：没有配准/矢量提取，不能证明轮廓坐标逐点一致。

### style-to-sketch-08-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-08-new-eeb227cd-05b9-4b11-992b-538055ca15cd-1.png>)

可见证据：极简线稿保留原尖领、短袖、单胸袋、5颗门襟扣及直下摆。 无多余可见缝线、文字、尺寸标注或色块。
失败点：未发现明确可见硬项失败。
未验证：没有配准/矢量提取，不能证明轮廓坐标逐点一致。

### style-to-sketch-09-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-09-old-423f9f9b-650c-4b96-ae7f-edc92714b4e7-1.png>)

可见证据：正面黑线保留源图尖领、短袖、无袋、弧形下摆与5颗完整门襟扣+领口小扣。 没有额外结构、文字或填色。
失败点：未发现明确可见硬项失败。
未验证：线稿不保证生产尺寸/缝线，未作逐点配准。

### style-to-sketch-09-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-09-new-390182b5-ed06-429e-bc4b-eb3fb2fc60e5-1.png>)

可见证据：门襟完整圆扣可数到6颗，另有领口小扣，共7处；源图是5颗完整门襟扣+领口小扣。 新增的最下端门襟扣清楚可见，非领口计数歧义。
失败点：凭空多出1颗完整门襟扣，违反可见结构保留。
未验证：其他线迹仅概念表达，非生产纸样。
最小修正方向：按源图门襟5颗完整扣及领口部分可见扣核对，删除无依据的最下端新增扣；保留失败图不重试。

### style-to-sketch-10-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-10-old-21d64d4d-449d-4b87-8799-7a23e39b7aee-1.png>)

可见证据：极简白底黑线保留5颗扣、单胸袋、尖领短袖和直下摆。 未增加不可见的袋缝虚线、图文或填色。
失败点：未发现明确可见硬项失败。
未验证：线条抽象与比例未作精确配准，不等同矢量/生产技术稿。

### style-to-sketch-10-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/style-to-sketch-10-new-25ec4a26-c6e4-43e1-abf8-653e41172b97-1.png>)

可见证据：极简白底黑线保留5颗扣、单胸袋、尖领短袖和直下摆。 未增加不可见的袋缝虚线、图文或填色。
失败点：未发现明确可见硬项失败。
未验证：线条抽象与比例未作精确配准，不等同矢量/生产技术稿。

### local-restyle-01-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-01-old-a8cc8140-4826-4c64-80fb-d18c9b48a4da-1.png>)

可见证据：原尖领改为柔和圆角领，无花边。 领口以外的浅蓝衣身、短袖、纽扣、弧形下摆及白底构图视觉上基本保留；领部连接自然。
失败点：未发现明确可见硬项失败。
未验证：没有真实mask及配准差分，区域外像素完全一致未验证；不作严格蒙版遵循通过声明。

### local-restyle-01-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-01-new-af10024a-e849-4322-ac42-40f96bad1a65-1.png>)

可见证据：原尖领改为柔和圆角领，无花边。 领口以外的浅蓝衣身、短袖、纽扣、弧形下摆及白底构图视觉上基本保留；领部连接自然。
失败点：未发现明确可见硬项失败。
未验证：没有真实mask及配准差分，区域外像素完全一致未验证；不作严格蒙版遵循通过声明。

### local-restyle-02-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-02-old-d81719ce-4409-4f86-a1e0-a717fab2ed52-1.png>)

可见证据：两侧袖口均增加了窄折边，原胸袋及5颗扣保留。 整件衣长构图基本相同，但两袖外端明显内缩，袖长变短；门襟原有角形扣也变成圆扣。
失败点：只加窄折边却明显缩短袖长。 未授权修改的扣形发生改变，平涂衣身还出现渐变明暗。
未验证：无真实mask，不能承诺像素级不变。
最小修正方向：回到原始flat素材，仅在原袖口内侧添加窄折边线，锁定袖端轮廓与原扣形/平涂；本轮不生成。

### local-restyle-02-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-02-new-2d56080b-2a39-47d3-b06f-52388e1a8289-1.png>)

可见证据：袖口窄折边明确，原有5颗角形扣、胸袋及大身轮廓保留。 袖端整体位置比旧版更接近源图；原纯平涂衣身出现轻微渐变，线条边缘也被重采样。
失败点：未指定改变的平涂表现出现轻微明暗渐变；尚不能称为仅袖口变化。
未验证：无真实mask及配准差分，不声明区域外逐像素一致。
最小修正方向：保持源图纯平涂与轮廓，仅保留袖口折边编辑，不把细微绘制风格漂移当材质改善。

### local-restyle-03-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-03-old-92386f1d-ef30-4291-b318-30ec50640064-1.png>)

可见证据：穿着者左胸（画面右侧）新增1只浅蓝同布贴袋，位置正确；其余衬衫外观基本保留。 袋底为明显向下收尖的五边形，不是要求的小方形贴袋。
失败点：袋底形状不符合明确方形要求。
未验证：无真实mask，区域外像素不变未验证。
最小修正方向：仅把新增袋底改为水平直边与近直角下角，保留尺寸/位置和其余衣身；本轮不重试。

### local-restyle-03-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-03-new-dc138755-f3ca-488e-835a-788b5a5b03a8-1.png>)

可见证据：穿着者左胸新增1只小型方形贴袋，平直袋底、两侧直边明确。 同色同布视觉衔接自然；衣身、领袖、纽扣和背景基本保留。
失败点：未发现明确可见硬项失败。
未验证：只能视觉判断基本保留，无真实mask或配准差分，不能承诺区域外逐像素一致。

### local-restyle-04-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-04-old-220341cd-c009-4645-bb04-09fd0c2ed8e0-1.png>)

可见证据：5颗原位置纽扣改为深棕色圆扣，大小视觉接近原扣。 尖领、短袖、胸袋、整体位置保留；原纯平涂大身出现柔和明暗渐变。
失败点：除纽扣外，原平涂效果也发生轻微改变。
未验证：严格同尺寸与区域外逐像素保持未做配准验证。
最小修正方向：保留5颗深棕圆扣编辑，恢复原始大身纯平涂，不添加光影或材质；不追加生成。

### local-restyle-04-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-04-new-b6d8546c-4233-43dd-b973-1398965d3403-1.png>)

可见证据：5颗扣换为深棕圆扣、位置及整体大小接近原图；领袖与袋轮廓保留。 原纯平涂大身有轻微渐变，非纽扣区域线条有重采样。
失败点：除按钮编辑外仍有轻微平涂表现漂移。
未验证：严格尺寸及区域外像素保持未配准验证。
最小修正方向：保留按钮改动，恢复其余区域原平涂表现；不宣称精确局部编辑。

### local-restyle-05-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-05-old-5d755491-f3ff-43b1-bc29-77c4d5abe4ad-1.png>)

可见证据：结果为浅弧形下摆，领、短袖、纽扣和浅蓝色基本保留。 原shirt源图下摆本来已是浅弧形，并非案例文字所说直下摆。
失败点：未发现明确可见硬项失败。
未验证：目标状态视觉满足，但该基准不能证明从直下摆改为弧形的能力；改动幅度及范围外像素一致未验证。

### local-restyle-05-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-05-new-c8520541-2bcc-4722-a751-08b796748669-1.png>)

可见证据：结果为浅弧形下摆，领、短袖、纽扣和浅蓝色基本保留。 原shirt源图下摆本来已是浅弧形，并非案例文字所说直下摆。
失败点：未发现明确可见硬项失败。
未验证：目标状态视觉满足，但该基准不能证明从直下摆改为弧形的能力；改动幅度及范围外像素一致未验证。

### local-restyle-06-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-06-old-7a34dece-14d4-472f-a50d-cc459528a42f-1.png>)

可见证据：原尖领改成无花边圆角领，整体衣身/单袋位置保留。 原角形扣被改成圆形，原平涂大身呈轻微渐变。
失败点：仅改领口却改变扣形及部分非领部绘制表现。
未验证：无真实mask，不保证区域外像素一致。
最小修正方向：保留圆角领，恢复原角形扣和纯平涂大身。

### local-restyle-06-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-06-new-f51c2c53-73e1-451e-8723-483aa638e412-1.png>)

可见证据：实现无花边圆角领，5颗原角形扣与单袋保留。 轮廓和袖端接近源图；非领部平涂仍有轻微明暗/细纹变化。
失败点：未指定区域的平涂表现有轻微漂移。
未验证：没有mask/配准差分，不作逐像素保持声明。
最小修正方向：保留领形编辑，恢复原平涂和非编辑区域呈现。

### local-restyle-07-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-07-old-8e2b1628-5cf9-4794-8b61-1a886c31069a-1.png>)

可见证据：两侧短袖口增加窄折边，袖端与衣身比例视觉接近原图。 领型、5颗完整门襟扣与领口小扣、浅蓝衣身及背景基本保留。
失败点：未发现明确可见硬项失败。
未验证：此前为下载失败暂停，恢复的是同一原上游结果而非追加生成；无mask/配准，区域外逐像素一致未验证。

### local-restyle-07-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-07-new-23d43cca-7a49-4955-ad94-0860d696b19a-1.png>)

可见证据：两边短袖口均可见窄折边带，袖长轮廓接近原图。 浅蓝衣身、尖领、门襟纽扣、弧形下摆和背景视觉上基本保留。
失败点：未发现明确可见硬项失败。
未验证：无真实mask/配准，区域外像素完全一致未验证。

### local-restyle-08-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-08-old-6fb795b5-b2cd-4c38-bd52-4edf959a6710-1.png>)

可见证据：源图已有左胸1只袋，旧版保留原袋并在上方增加1只小袋，总计2只，按‘增加一只’字面完成新增。 原角形扣变圆扣，大身出现渐变；新增袋略偏长方形，未有尺寸定义。
失败点：未指定改变的扣形和纯平涂发生漂移。
未验证：用户是否意在新增后总数1仍有业务歧义；报告按明确‘增加’而非‘替换’审查，未作像素保留证明。
最小修正方向：保留原袋及新增袋，恢复原角形扣与纯平涂；若目标其实是总共1只袋，应先更正案例文字，不能追溯判第二袋是擅自新增。

### local-restyle-08-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-08-new-469db16c-ad79-4ce9-a69c-8d971851c200-1.png>)

可见证据：仍只有左胸1只袋，原袋被改成稍小更直角的袋，未新增第二只；角形扣保留。 平涂区域有轻微渐变。
失败点：文字要求在原图基础上‘增加一只’且未指定区域不变，新版却把既有袋改形，没有完成字面新增动作。
未验证：案例源图已有左胸袋，目标总袋数可澄清；不能用常见设计偏好判1只更合理。
最小修正方向：先确认需求是新增另一只还是替换既有袋；若按现有文字，应保留旧袋并新增，不得优化器自行把增加改为替换。

### local-restyle-09-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-09-old-c8351942-b9bc-4eea-89d3-eb5690e814e7-1.png>)

可见证据：5颗完整门襟扣均改为深棕圆扣，衣身浅蓝外观基本保留。 领口翻折处的部分可见扣仍浅蓝，没有随‘纽扣’整体替换要求改棕。
失败点：部分可见领口扣漏改，尚未完成全体纽扣替换。
未验证：严格同尺寸与区域外逐像素不变未验证。
最小修正方向：包含源图领口部分可见扣在内统一改深棕，保留原位置与尺寸；不把计数口径不明当漏改豁免。

### local-restyle-09-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-09-new-a3102156-9e74-4035-8593-374d2a35eb00-1.png>)

可见证据：5颗完整门襟扣均改为深棕圆扣，衣身浅蓝外观基本保留。 领口翻折处的部分可见扣仍浅蓝，没有随‘纽扣’整体替换要求改棕。
失败点：部分可见领口扣漏改，尚未完成全体纽扣替换。
未验证：严格同尺寸与区域外逐像素不变未验证。
最小修正方向：包含源图领口部分可见扣在内统一改深棕，保留原位置与尺寸；不把计数口径不明当漏改豁免。

### local-restyle-10-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-10-old-27a8c82a-cc86-4431-8e5a-08feaf232b0c-1.png>)

可见证据：源图直下摆改为浅弧形，整体长度与主结构接近原图。 原角形扣变成圆扣，大身从纯平涂变轻微渐变。
失败点：仅改下摆却改变扣形和大身平涂效果。
未验证：未进行配准/像素级区域外保留检查。
最小修正方向：保留下摆弧线，恢复原角形扣与纯平涂。

### local-restyle-10-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/local-restyle-10-new-af5e5659-8f30-4049-9170-5d38c3da8149-1.png>)

可见证据：实现浅弧形下摆，保留原5颗角形扣与单胸袋。 未指定区域的平涂仍被处理成轻微渐变。
失败点：非编辑大身平涂表现有轻微漂移。
未验证：无真实mask与配准，不宣称逐像素不变。
最小修正方向：保留下摆改动，恢复其他区域平涂表现。

### garment-colorway-01-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-01-old-4e2f19d7-dfe0-4f02-94c2-50107c4a1f3d-1.png>)

可见证据：衣身、袖子与领子改为柔和鼠尾草绿，符合自然柔和方向。 门襟扣及部分可见领口扣仍为原浅蓝色；无新图案、口袋或额外部件，版型和白底保持。
失败点：未发现明确可见硬项失败。
未验证：色名仅视觉方向，未做实物色差或精确RGB验收；没有mask，不保证区域外像素不变。

### garment-colorway-01-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-01-new-4c759a2c-6763-463a-9a46-dad583326c1c-1.png>)

可见证据：衣身和袖子为柔和灰绿，领子为米色，仍在全部面料智能配色授权范围。 纽扣呈灰白而非源图浅蓝；浅蓝扣在旧版中明显保留。
失败点：‘纽扣保持原色’未遵守，扣色被改为灰白。
未验证：不作精确色差或逐像素保持结论；纹理真实纤维未验证。
最小修正方向：保留已选面料配色，恢复源图浅蓝扣色；不得因绿/米配色协调而放宽按钮保色约束。

### garment-colorway-02-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-02-old-3dabae36-e706-4a10-b552-0ac8f406aef5-1.png>)

可见证据：大身深蓝灰、胸袋陶土棕，袖子及领子仍在原米色方向；5颗扣及单袋轮廓保留。 源图是无织纹的平涂示意图，输出给大身、袖子及领子添加了细密织物纹理；原角形扣变成圆扣。
失败点：只换色却新增源图不存在的织物肌理，涉及未授权袖子/领子。 纽扣形状未经授权改变。
未验证：两枚HEX的精确数值/生产色差未验证；不能以材质更真实作为通过理由。
最小修正方向：回到原始flat素材，仅替换大身指定色区的平涂颜色，保留所有原轮廓、角形扣和无织纹的绘制方式。

### garment-colorway-02-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-02-new-ac190386-1fda-4e62-a51f-8b53d7e25bda-1.png>)

可见证据：大身深蓝灰、胸袋陶土棕，袖子及领子仍在原米色方向；5颗扣及单袋轮廓保留。 源图是无织纹的平涂示意图，输出给大身、袖子及领子添加了细密织物纹理；原角形扣变成圆扣。
失败点：只换色却新增源图不存在的织物肌理，涉及未授权袖子/领子。 纽扣形状未经授权改变。
未验证：两枚HEX的精确数值/生产色差未验证；不能以材质更真实作为通过理由。
最小修正方向：回到原始flat素材，仅替换大身指定色区的平涂颜色，保留所有原轮廓、角形扣和无织纹的绘制方式。

### garment-colorway-03-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-03-old-09a8ec88-f50e-4fed-8dfd-0c005f75a333-1.png>)

可见证据：短袖衬衫轮廓与浅蓝扣色大致保留。 整件领、袖、衣身均出现参考针织图的几何雪花/条纹，并呈针织组织；不是仅提取颜色。
失败点：把配色参考图的纹样与针织材质一同迁入主服装，违反参考职责与仅换色范围。
未验证：真实织物与实物色差未验证；模型返回成功不等于参考职责遵循通过。
最小修正方向：以原衬衫为结构/材质唯一基准，只提取参考图奶油、海军蓝、砖红、芥末黄颜色，不复制图案或组织；保留负例不重试。

### garment-colorway-03-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-03-new-ae22654c-f175-425e-a900-6bf2f2e6010e-1.png>)

可见证据：衣身奶油、领子海军蓝、门襟砖红、袖口芥末黄，使用配色参考的主要色族。 没有复制针织几何花纹；保留无袋衬衫结构和梭织外观、浅蓝纽扣、白底构图。
失败点：未发现明确可见硬项失败。
未验证：配色区域面积比例未作数值测量，不能声明精确复制参考色彩比例；色值及实物色差不保证。

### garment-colorway-04-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-04-old-a46c2098-6eed-4c2b-8622-92d5fbc60206-1.png>)

可见证据：大身改为自然柔和灰绿，袖子米色与领子米白基本保留。 无织纹的平涂源图变为带细密织物质感的图像，尤其袖子与大身。 5颗原角形扣仍在。
失败点：仅大身换色却对全衣引入新纹理；不满足面料/区域外保持。
未验证：精确色值与区域外像素不变未测。
最小修正方向：基于原始平涂素材，只替换大身颜色，保留其余纯色填充与角形纽扣；不追加生成。

### garment-colorway-04-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-04-new-f9c5faf2-fb54-43b9-ac0c-b94ffd8358fd-1.png>)

可见证据：大身改为自然柔和灰绿，袖子米色与领子米白基本保留。 无织纹的平涂源图变为带细密织物质感的图像，尤其袖子与大身。 5颗原角形扣被改成圆扣。
失败点：仅大身换色却对全衣引入新纹理；不满足面料/区域外保持。 纽扣形状也改变。
未验证：精确色值与区域外像素不变未测。
最小修正方向：基于原始平涂素材，只替换大身颜色，保留其余纯色填充与角形纽扣；不追加生成。

### garment-colorway-05-old — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-05-old-d001b150-f769-4d16-8b0e-e1c2b2bf0316-1.png>)

可见证据：整件服装呈深森林绿，原浅蓝纽扣保留。 未见第二指定色#E8DCC8米色在面料中体现。
失败点：只使用选定双色中的绿色，遗漏米色配色。
未验证：没有色区分配要求，不武断指定米色必须落在哪个部件；实物色差不验证。
最小修正方向：在既有衣片/领/门襟等授权面料区合理纳入米色，不修改版型和原扣色。

### garment-colorway-05-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-05-new-d4293494-61a7-4b87-a597-dfeb0a4a86ed-1.png>)

可见证据：衣身和袖子森林绿，领与门襟米色，两枚指定色方向均被使用。 浅色扣保留蓝灰视觉，未带入图案或其他款式；衬衫版型、缝线、背景基本保持。
失败点：未发现明确可见硬项失败。
未验证：纽扣精确色值、配色HEX及实物色差未测；颜色视觉保留不等同逐像素保留。

### garment-colorway-06-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-06-old-b5d6a3fe-f8f3-48fa-a100-fa8fc6e2464c-1.png>)

可见证据：大身复制针织参考的雪花几何及横条纹，而非仅取颜色；纽扣仍5颗。 领片从原米白变为与袖子相近的米棕，还新增织纹。
失败点：配色参考职责被错误扩大为图案/材质参考。 要求保留原色的领片也被改色。
未验证：精确色值、织物真实性以及像素级保留未验证。
最小修正方向：从flat原稿重新限定仅取四个主要色族，禁止纹样/织物迁移，且仅大身允许换色；保留负例不生成。

### garment-colorway-06-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-06-new-8d79f115-9b2e-496b-9950-9e9bc172e558-1.png>)

可见证据：大身复制针织参考的雪花几何及横条纹，而非仅取颜色；纽扣仍5颗。 领片仍为原米白方向，袖子米棕方向保留；但衣身和袋均有针织花纹。
失败点：配色参考职责被错误扩大为图案/材质参考。
未验证：精确色值、织物真实性以及像素级保留未验证。
最小修正方向：从flat原稿重新限定仅取四个主要色族，禁止纹样/织物迁移，且仅大身允许换色；保留负例不生成。

### garment-colorway-07-old — PASS

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-07-old-5a868e68-720b-4d50-83a9-d2dcdf81e009-1.png>)

可见证据：整件面料变为自然柔和浅绿，浅蓝原扣仍清楚。 尖领短袖无袋、弧形下摆及白底基本保持，没有新增图案或材质类别。
失败点：未发现明确可见硬项失败。
未验证：色值、实物色差及区域外逐像素保持未验证。

### garment-colorway-07-new — MINOR REVISION

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-07-new-6ac61651-3b51-4faa-b81f-9502d0829dd6-1.png>)

可见证据：衣身灰绿、领片米色，为允许的自然柔和面料配色。 纽扣被染成灰绿/米灰，源图浅蓝扣色不再保留。
失败点：纽扣保持原色的明确条件失守。
未验证：不作精确色差及逐像素一致声明。
最小修正方向：恢复源图浅蓝扣色，保留授权面料换色，不为了协调配色改变辅料颜色。

### garment-colorway-08-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-08-old-2cdeeb21-ad79-437f-a033-b23923f20987-1.png>)

可见证据：大身粉色、袋子灰绿，两指定色方向均出现；袖子米棕、领子米白没有被改粉。 原平涂大身/袖子新增织物质感，角形扣变圆形。
失败点：只换色却新增面料织纹并改变扣形。
未验证：HEX精确值、实物色差和像素级保留未测。
最小修正方向：保留正确的色区分配，去掉新增织纹并恢复原角形扣，保持原平涂。

### garment-colorway-08-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-08-new-5f84fb47-9617-46ad-8685-bbea37046523-1.png>)

可见证据：大身粉色、胸袋灰绿、角形扣及米白领保留。 左右袖子也被改成粉色，违反‘袖子与领子保留原色’；原平涂图也出现细密面料纹理。
失败点：换色超出大身范围，明确禁止改色的两只袖子被染粉。 原平涂被织物化。
未验证：HEX精确值、实物色差和像素级保留未测。
最小修正方向：恢复两袖原米棕色和原无织纹表现，仅大身/已授权色区改色；不追加生成。

### garment-colorway-09-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-09-old-0871e75a-a8a8-4f36-847a-dedf59ee7a55-1.png>)

可见证据：整件衬衫复制参考针织几何花纹与组织，浅蓝纽扣和主体轮廓保留。 授权仅参考颜色，不包含图案/材质迁移。
失败点：配色参考被当作图案与面料参考，改变原素色梭织效果。
未验证：生产色差及真实材质未验证。
最小修正方向：仅取参考色族，保留原素色梭织，不以本失败图作新输入。

### garment-colorway-09-new — PASS

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-09-new-5b226976-99ae-4fb5-be6d-fe0c9f85a5e4-1.png>)

可见证据：奶油衣身、海军蓝领、砖红门襟、芥末袖口体现参考主要色族。 不复制几何纹样，保留原梭织感、浅蓝纽扣、无袋结构与白底。
失败点：未发现明确可见硬项失败。
未验证：没有测量色彩面积占比或精确色差，不能声称定量复制参考色比。

### garment-colorway-10-old — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-10-old-fedfbb4e-dc48-46fc-8be3-5dae74488fab-1.png>)

可见证据：大身自然灰绿，袖子维持米棕、领片为浅色方向，5颗扣和单袋仍在。 平涂原稿被添加全衣细密织纹，源图没有该肌理；袖子也受到影响。
失败点：只改大身配色却重画面料纹理，并涉及保留区域。
未验证：纽扣精确角数/尺寸与局部像素保持未测；不把无法确定细节判为通过证据。
最小修正方向：只换大身原纯色填充，保留袖领原像及无织纹绘制方式，避免统一写实化。

### garment-colorway-10-new — REDO

[查看原始结果图](<quality-matrix/visual-v1/garment-colorway-10-new-f58a6747-d9fb-43fb-bff3-bf41d4a4adc1-1.png>)

可见证据：大身自然灰绿，袖子维持米棕、领片为浅色方向，5颗扣和单袋仍在。 平涂原稿被添加全衣细密织纹，源图没有该肌理；袖子也受到影响。
失败点：只改大身配色却重画面料纹理，并涉及保留区域。
未验证：纽扣精确角数/尺寸与局部像素保持未测；不把无法确定细节判为通过证据。
最小修正方向：只换大身原纯色填充，保留袖领原像及无织纹绘制方式，避免统一写实化。

## 来源与边界

plan SHA-256：ace89f230a363ef53cbedea9427495552afc3d1a74410a54e0d386faeee1df15。78 张结果 hash 全部匹配 ledger，逐图路径/hash/源图职责/原输入与检查项见同名 JSON。

本次只创建本报告与同名 JSON，不改 plan、ledger、源图、结果图或代码；没有额外生成。
