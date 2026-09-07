# 视频模型：渠道参数与当前接入范围

以下参数来自 **APIMart 对应型号的正式接口文档**，并补充真实调用发现的约束。四个型号均使用 `POST /v1/videos/generations`。高级媒体预检、素材上传、模式路由和幂等轮询已接入；四个视频型号均已有真实成功结果，但这不等于每个高级模式均已实付验收。

## 官方参数与默认值

| 项目型号 | 上游 `model` | 时长（整数秒） | 分辨率 | 比例 | 输出音频控制 | 水印 |
| --- | --- | --- | --- | --- | --- | --- |
| MiniMax-H3 | `MiniMax-H3` | 4–15，默认 5 | `768P` / `2K`，默认 `2K` | `21:9` / `16:9` / `4:3` / `1:1` / `3:4` / `9:16`；文生默认 `16:9` | 原生带音轨；未提供 `generate_audio` 开关 | `watermark`，默认 `false` |
| doubao-seedance-2.5 | **`seedance-2.5`** | 4–30，默认 5；`-1` 自动 | `480p` / `720p` / **`1080p`**，默认 `720p` | `16:9` / `4:3` / `1:1` / `3:4` / `9:16` / `21:9` / `adaptive`，默认 `adaptive` | `generate_audio`，默认 `true` | `watermark`，默认 `false` |
| wan2.7 | `wan2.7` | 2–15，默认 5 | `720P` / `1080P`，默认 `1080P` | `16:9` / `9:16` / `1:1` / `4:3` / `3:4`，文生默认 `16:9` | 未提供生成声音开关；可传自定义 `audio_url` | `watermark`，默认 `false` |
| happyhorse-1.1 | `happyhorse-1.1` | 3–15，默认 5 | `720P` / `1080P`，默认 `1080P` | `16:9` / `9:16` / `1:1` / `4:3` / `3:4`，默认 `16:9` | 该接口文档未提供音频字段 | `watermark`，默认 `false` |

逐型号来源：[MiniMax-H3](https://docs.apimart.ai/en/api-reference/videos/minimax-h3/generation)、[Seedance 2.5](https://docs.apimart.ai/cn/api-reference/videos/seedance-2-5/generation)、[Wan 2.7](https://docs.apimart.ai/cn/api-reference/videos/wan2.7/generation)、[HappyHorse 1.1](https://docs.apimart.ai/cn/api-reference/videos/happyhorse-1.1/generation)。项目保留已有 `doubao-seedance-2.5` 配置标识与计费记录，上游请求转换为文档规定的 `seedance-2.5`，不假定两者是渠道可互换别名。

`supportsAudio` 在现有能力类型中只表示“渠道提供输出音频开关”。它为 `false` 不代表模型只能生成静音视频；尤其不能把 MiniMax-H3 的原生音轨误写为不支持音频。已有用户设置可以覆盖渠道默认值，切换模型时只归一不支持的选项。

## 图像模式、数量与比例行为

| 型号 | 官方输入模式 | 当前应用实际映射 | 比例行为 |
| --- | --- | --- | --- |
| MiniMax-H3 | `first_frame_image` / `last_frame_image` 指定首尾帧；`image_urls` 最多 9 张；还支持最多 3 段视频和 3 段音频参考 | 文生、首/尾/首尾帧、多图参考及视频/音频参考均按显式模式映射；首尾帧字段与 `image_urls` 互斥 | 帧模式比例固定 `adaptive`；文生/多图参考可用具体比例 |
| Seedance 2.5 | 最多 30 图、10 段视频、10 段音频；首尾帧使用 `image_with_roles`；支持参考、编辑、延长 | 显式模式贯通，素材顺序保留；编辑固定 `duration=-1`，延长和帧模式使用 `adaptive` | 文生/参考图支持完整比例列表；帧、编辑、延长不发送虚假的固定比例 |
| Wan 2.7 | `image_urls` 1 图为首帧、2 图为首尾帧；视频输入为续写；可选 1 段音频 | 文生、首帧、首尾帧、续写均贯通；续写只接受视频及可选尾帧图片 | 图生/续写由输入媒体决定比例；仅文生发送 `size` |
| HappyHorse 1.1 | `first_frame_image` 为 I2V；`image_urls` 1–9 图为 R2V；不支持视频/音频输入和编辑 | 文生、首帧、参考图三模式贯通；按显式模式校验图片数量 | 首帧跟随输入图；文生/参考图可选具体比例 |

依据仍为上述四个型号文档的模式路由、图片字段与比例规则。视频创作台和画布提供对应型号的显式模式选择器。单图首帧、多图参考是本项目自动模式的交互规则，不是声称渠道会按张数自动路由 MiniMax。Wan 续写的 `duration` 是输出总时长，必须大于源视频时长；该限制由真实上游错误确认，前后端均会拦截。

## 图片媒体规格与接入边界

| 型号 | 官方图片规格 | 本项目当前边界 |
| --- | --- | --- |
| MiniMax-H3 | JPG/JPEG/PNG/WebP/HEIC/HEIF；单张 ≤30 MB；边长 256–5760 px；宽高比 0.4–2.5；首、尾帧各≤1，参考图≤9 | 当前上传链路≤10 MB；页面接受 JPEG/PNG/WebP；GIF 不作为 MiniMax 参考图提交 |
| Seedance 2.5 | JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF；单张 <30 MB；边长 300–6000 px；宽高比 0.4–2.5；≤30 图 | 当前页面上传≤10 MB，JPEG/PNG/WebP。真人素材官方要求先经过私域素材审核，本项目尚未接入该审核流程 |
| Wan 2.7 | 该 generation 文档规定1–2图与 URL/角色顺序，未列图片像素/字节完整上限 | 不编造模型尺寸上限。遵守当前入口≤10 MB、JPEG/PNG/WebP；上游仍可按实际图片规格拒绝 |
| HappyHorse 1.1 | JPEG/JPG/PNG/BMP/WebP；≤10 MB；首帧短边≥300 px，宽高比0.4–2.5；参考图推荐短边≥720p且短/长边≥0.4；1–9图 | ≤10 MB；当前上传适配器没有 BMP 支持，页面只接受 JPEG/PNG/WebP；GIF 不作为 HappyHorse 参考图提交 |

[APIMart 上传图片接口](https://docs.apimart.ai/cn/api-reference/uploads/images)实际支持 JPEG/PNG/WebP/GIF、最大 **20 MB**，返回临时公开 URL；本项目现有视频上传适配器的 **10 MB 是产品接入限制，不是官方上传上限**。模型允许某种图片格式不等于当前上传链路已经支持。前端校验已知尺寸，服务端使用 `ffprobe` 读取实际字节中的格式、尺寸、时长和帧率，再验证文档明确的限制；不信任上传时自报的媒体元数据。未公开的渠道限制仍可能导致上游拒绝。

当前服务端视频适配器已接收图片、视频和音频素材，并在上传、预检、声明额度和提交前统一校验：MiniMax/Seedance/Wan 的视频与音频数量、单文件大小、时长总和、尺寸比例和模式冲突均会在首个上游请求前失败；HappyHorse 明确拒绝视频、音频和编辑模式。素材引用优先读取浏览器本地持久化字节，无法读取时才使用应用签名的 HTTPS 资源地址，不会把 `blob:`、本地路径或客户端伪造 URL 发给渠道。

本地后端需安装 FFmpeg 并确保 `ffprobe` 在 PATH，或设置 `FFPROBE_PATH`；Docker API/Worker 镜像已包含它。探针仅解析本地临时文件，不跟随网络播放列表。音视频上传到应用后，渠道仍需要公开 HTTPS 素材入口：正式环境配置 `S3_PUBLIC_ENDPOINT`，演示环境配置 `DEMO_PUBLIC_ASSET_ORIGIN`。只有 localhost、且没有可复用的上游结果地址时，这类任务会在付费提交前提示配置缺失；不会擅自开放公网隧道。

Seedance 自动/编辑模式的渠道预扣按最多 30 秒输出加输入视频时长计算，完成后由渠道按实际用量结算。应用内部积分仍按管理员配置的每任务价格计算，`upstreamBillingSeconds` 是渠道用量提示，不是新的应用积分计价规则。

## 同步校验与验证依据

- 前端 `video-model-parameters.ts` 与服务端 `video-models.ts` 保持同一可选范围；Seedance 新增 1080p、MiniMax 水印进入实际请求。
- 图片/视频/音频超量、格式、大小、时长、尺寸和模式冲突在前端上传前失败；后端再次独立校验数量、模式及文档明确的提示词上限（MiniMax 7000、Wan 5000、HappyHorse 2500 字符）。Seedance 该文档未明确提示词字数，未自行设定。
- 首帧模式预检返回 `size=adaptive`，实际请求省略不生效的比例字段；不会把用户选中的比例如实控制输出的假象带到上游。
- 测试覆盖全部可选时长/分辨率/比例、前后端一致性、图/视频/音频数量边界、模式互斥、预检和提交字段一致、无效输入零网络请求、公开素材签名，以及原任务恢复不重复提交。

真实验证覆盖 MiniMax 4 秒文生、Seedance 4 秒首尾帧、HappyHorse 3 秒首帧和 Wan 2 秒文生。Wan 曾因续写总时长不足而失败，现已补上预检；纠正后的续写尚未再次付费验证。视频编辑、延长、多视频/音频参考的契约与安全边界有自动测试，但不冒充逐模式实付成功。

本地验收目录（仓库外）`verification-results/real-model-checks/` 保存结果字节、SHA-256、原任务号和汇总。14 个已配置图片/视频/聊天模型均有真实成功结果；Gemini Pro 通过带输出上限的服务端适配器验证，Wan 文生结果在本地服务停止后通过原上游任务只读恢复。累计保守预算预留 14.98 元（含失败和结果不明尝试），不是渠道最终账单。生产部署明确不在本轮范围内。
