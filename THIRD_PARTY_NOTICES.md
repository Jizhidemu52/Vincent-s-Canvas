# 第三方来源与许可边界

根目录 [LICENSE](LICENSE) 只覆盖本项目权利人有权许可的原创部分，**不将第三方组件重新许可为非商业，也不撤销它们原有的授权**。代码旁、包内或上游发布物中的原始版权、许可证及 NOTICE 应一并保留；有冲突或缺失时应先核实，不能以本项目声明覆盖。

## 随仓库提供的第三方代码

| 内容 | 来源与声明 | 范围 |
| --- | --- | --- |
| 实验工作台的 chroma.js 3.2.0 浏览器模块 | [原始 LICENSE](labs/design-workbench/recipe/vendor/chroma-js/LICENSE) · [版本、来源和校验值](labs/design-workbench/recipe/vendor/chroma-js/来源与许可.txt) | 保留 BSD-3-Clause 及包内 ColorBrewer Apache-2.0 声明；不是本项目原创，也不是实体色标准或品牌色库授权 |

## 通过安装获得的依赖

前端、后端和文档依赖分别以 [web/package.json](web/package.json)、[server/package.json](server/package.json)、[docs/package.json](docs/package.json) 及其锁文件确定版本。React、Ant Design、Vite、Bun 生态依赖、字体、图标等保留各自许可证。安装后应查看各包随附的 `LICENSE` / `NOTICE`；打包或分发依赖时也须保留必要声明。

本文件是项目级来源导航，不是全部传递依赖的穷尽许可清单，也不是“所有依赖均可商用”的保证。生产分发前应针对实际构建产物核实依赖和素材的授权义务。

## 独立源码实验室

[labs/source-modules/source-manifest.json](labs/source-modules/source-manifest.json) 记录六个上游项目的官方仓库、固定提交和许可路径；[实验说明](labs/source-modules/README.txt) 明确它们不是正式画布集成。上游源码由脚本另行下载，不随本仓库复制。

- Fabric、Loomic 与 infinite-canvas SDK：按清单所载根许可及包级声明保留原文。
- InvokeAI：保留其 Apache-2.0 条款与相应声明。
- ComfyUI：保留其 GPL 条款；独立实验不等于可直接闭源集成。
- tldraw：保留固定版本的自定义许可证和 SDK 声明；实验运行不代表已获得生产或商业授权。

不能把本项目的非商业许可、另行商用授权或实验通过，理解为对上述项目的重新授权或完整合规审计。

## 图片、模型、名称与商标

- 用户上传的图片、客户资料和生成输出不因被软件处理而转移所有权；合法使用须核实素材来源与模型服务条款。
- 模型名称、供应商 Logo、第三方图标、字体和颜色资料仅用于说明来源或功能识别；各权利仍属于其权利人，不表示官方合作、认可或背书。
- 首页截图使用隔离演示数据展示真实界面，不构成模型质量承诺或第三方品牌使用授权。

若发现遗漏的来源、版权或许可声明，请向[维护者](https://github.com/Jizhidemu52)提供文件路径、上游链接和依据，以便核实补正。
