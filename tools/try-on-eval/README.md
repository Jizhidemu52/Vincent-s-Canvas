# 上身评测（离线）

从项目根目录运行。此工具不调用出图或评分供应商，也不触碰发布十单的账本。

- `bun tools/try-on-eval.ts plan --round 1 --group 帽子 --cases`：输出逐样品、取景、模特和做法的请求计划；两步精修的第二张单独计数，评分调用另计。
- `bun tools/try-on-eval.ts plan --round 2 --group 帽子 --records ./round1.json`：基准上下文相同，单项至少提升 0.3 分才纳入组合；没有改善则维持基准。第三轮从第二轮候选中选优。
- `bun tools/try-on-eval.ts report --round 3 --group 帽子 --records ./complete.json --media ./run/pairs.json`：分数优先用人工修正；输出统计和并排展示原图与结果的本地 HTML。仅查看统计可省略 `--media`。
- `bun tools/try-on-eval.ts snapshot --round 3 --group 帽子 --records ./complete.json --origin synthetic --at 2026-11-21T00:00:00.000Z`：只输出待审摘要，不修改线上做法。时间使用实际验收时间。仅当完整回执及人工抽查都齐全时，才由维护者审查原件和来源后把摘要追加至 `shared/try-on-review-history.json`，随版本发布。真实产品照片用 `physical`；合成图必须单列。未知来源不可发布。

回执是 `[{round,group,rows}]`；每行需与计划的 `sampleId,modelIdentity,variant,repeat` 完全对应，包含实际 `outputs,elapsedMs,automatic`，以及抽查时的 `reviewed`。两种评分均包含 0 到 5 的 `style,color,detail,wear,natural`。进入下一轮前，上一轮至少人工复核两成。三轮完整后每件产品和模特组合有三个独立结果；一次测试通过并不表示品类已稳定。

对比页的 `pairs.json` 是条目数组，逐项包含同一组四个键、`product` 和 `result`（均为 `{path,sha256}`）、`mustKeep`（必须保留的特征数组）与 `note`。只读清单所在目录内的本地 PNG、JPEG、WebP；SHA-256 不符即拒绝出报告。报告与清单同目录，不覆盖已有报告，不上传图片。摘要仅含聚合数据，没有用户、原图路径或素材地址。
