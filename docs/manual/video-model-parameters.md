# 视频模型：渠道参数与当前接入范围

以下参数来自 **APIMart 对应型号的正式接口文档**，不是同品牌旧型号、营销页或本项目旧配置推断。四个型号均使用 `POST /v1/videos/generations`。未执行付费生成，文档核对不等同于上游真实出片验收。

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
| MiniMax-H3 | 仅提示词为文生；`first_frame_image` / `last_frame_image` 指定首尾帧；`image_urls` 最多 9 张且始终代表参考图，与首尾帧字段互斥 | 0 图文生；1 图沿用首帧；2–9 图全部按顺序送 `image_urls`，不丢弃其余图片、不混成首尾帧 | 首帧比例跟随原图，不发送 `aspect_ratio`；文生与多图参考可使用具体比例 |
| Seedance 2.5 | 最多 30 图；`image_urls` 均为参考图；首尾帧需显式 `image_with_roles` | 0 图文生；1–30 图全部作为参考图。未提供首尾帧角色选择器 | 当前文生/参考图模式支持完整比例列表；官方首尾帧、延长只可 `adaptive`，编辑还要求 `duration=-1` |
| Wan 2.7 | `image_urls` 1 图为首帧、2 图为首尾帧；也可使用角色数组；视频输入为续写 | 0 图文生；1–2 图按首帧/首尾帧顺序提交 | 只在文生时发送 `size`；图生由输入图决定 |
| HappyHorse 1.1 | 仅文本 T2V；`first_frame_image` 为 I2V；`image_urls` 1–9 图为 R2V；两媒体字段互斥 | 三模式明确贯通。选择 reference 时即使只有 1 图也送 `image_urls`；未指定模式时单图首帧、多图参考 | I2V 不发送 `size`，跟随首帧图；T2V/R2V 可选具体比例 |

依据仍为上述四个型号文档的模式路由、图片字段与比例规则。单图首帧、多图参考是本项目未显式选择模式时的交互规则，不是声称渠道会按张数自动路由 MiniMax。MiniMax 的尾帧/首尾帧与单图 R2V 均属官方能力，但本轮没有新增对应模式选择器。

## 图片媒体规格与接入边界

| 型号 | 官方图片规格 | 本项目当前边界 |
| --- | --- | --- |
| MiniMax-H3 | JPG/JPEG/PNG/WebP/HEIC/HEIF；单张 ≤30 MB；边长 256–5760 px；宽高比 0.4–2.5；首、尾帧各≤1，参考图≤9 | 当前上传链路≤10 MB；页面接受 JPEG/PNG/WebP；GIF 不作为 MiniMax 参考图提交 |
| Seedance 2.5 | JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF；单张 <30 MB；边长 300–6000 px；宽高比 0.4–2.5；≤30 图 | 当前页面上传≤10 MB，JPEG/PNG/WebP。真人素材官方要求先经过私域素材审核，本项目尚未接入该审核流程 |
| Wan 2.7 | 该 generation 文档规定1–2图与 URL/角色顺序，未列图片像素/字节完整上限 | 不编造模型尺寸上限。遵守当前入口≤10 MB、JPEG/PNG/WebP；上游仍可按实际图片规格拒绝 |
| HappyHorse 1.1 | JPEG/JPG/PNG/BMP/WebP；≤10 MB；首帧短边≥300 px，宽高比0.4–2.5；参考图推荐短边≥720p且短/长边≥0.4；1–9图 | ≤10 MB；当前上传适配器没有 BMP 支持，页面只接受 JPEG/PNG/WebP；GIF 不作为 HappyHorse 参考图提交 |

[APIMart 上传图片接口](https://docs.apimart.ai/cn/api-reference/uploads/images)实际支持 JPEG/PNG/WebP/GIF、最大 **20 MB**，返回临时公开 URL；本项目现有视频上传适配器的 **10 MB 是产品接入限制，不是官方上传上限**。模型允许某种图片格式不等于当前上传链路已经支持。像素与宽高比要求目前由上游验证，不能声称客户端已完整检查。

当前服务端视频适配器只接收图片。MiniMax 官方的参考视频/音频、Seedance 的视频/音频/编辑/延长/首尾帧、Wan 的自定义音频和视频续写都尚未接入，页面不可呈现为可执行入口。旧草稿中的视频/音频引用保留并允许清除，提交前明确拒绝，不静默丢弃。HappyHorse **1.1** 文档没有视频编辑模式，不能套用 **1.0** 的 EDIT 字段。

## 同步校验与验证依据

- 前端 `video-model-parameters.ts` 与服务端 `video-models.ts` 保持同一可选范围；Seedance 新增 1080p、MiniMax 水印进入实际请求。
- 图片超量、未接入的视频/音频引用以及 HappyHorse 错误模式组合在前端上传前失败；后端独立校验数量、模式及文档明确的提示词上限（MiniMax 7000、Wan 5000、HappyHorse 2500字符）。Seedance该文档未明确提示词字数，未自行设定。
- 首帧模式预检返回 `size=adaptive`，实际请求省略不生效的比例字段；不会把用户选中的比例如实控制输出的假象带到上游。
- 测试覆盖全部可选时长/分辨率/比例、前后端一致性、图数量边界、模式互斥、单图 reference、预检和提交字段一致、无效输入零网络请求，以及原任务恢复不重复提交。

未进行真实付费调用；尚未验证上游素材审核、实际成片与最新账号渠道可用性。
