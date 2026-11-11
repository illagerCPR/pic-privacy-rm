# PicPrivacy 路线图

维护者向文档：按「收益 ÷ 代价」排序，不是承诺。动手前请对照 [AGENTS.md](AGENTS.md) 里七条不可破坏的约束。

发布日期：2026-11-01 · 首版基线 `cceb78d` · 改进第一轮 `3f02dfd`

---

## 明确不做

- **视频元数据**（MP4 `udta` / `meta`）—— 范围与定位都不匹配
- **CLI 或服务端版本** —— 出离「纯前端零网络」
- **把自研解析换成第三方库** —— 会让「白名单 + 零重编码 + 自复检」这套可验证性打折

---

## 其它待办（低优先级）

`TIFF` 的 BigTIFF、SubIFD、老式 JPEG（压缩方式 6，目前一律拒绝而不是半清理）；`BMP` / `JXL` 支持；
`avis` 序列（带 `moov`，同样明确拒绝）。

## 已完成

七种格式的无损引擎（JPEG / PNG / WebP / GIF、共用 ISOBMFF 栈的 HEIC / AVIF，以及 TIFF）、双语界面、
单张与批量、方向烘焙开关、service worker 离线、CI 与 Pages 自动部署；「全部元数据」视图（全量 EXIF /
XMP / IPTC / C2PA 展开、厂商字节 hex 预览、清理前后双列对比）；质量面为 **172 个单测（CI）+ 32 个
真实样本用例（本地）+ 18 个 Chrome e2e**，外加 `pnpm verify` 独立复核 46 个输出文件与离线断言。

**改进第一轮（2026-11-11，P0/P1/P2）**：批量 ZIP 只收 `done`/`clean`，复检失败的产物不再混进归档；
`verifyBlob` 按用户设置复检，保留 trailer 不再被判失败；方向烘焙失败会回退未烘焙结果并打标；引擎错误
改为 typed code + i18n；诊断报告默认把 GPS、序列号、作者替换为 `[redacted]`（设置里可关闭）；scan/strip
改为双 worker，列表行 memo + `content-visibility`，PNG 的 IDAT 不再做 CRC 全量读、JPEG 熵扫描改用
`indexOf`，inspect 缓存加上限，报告哈希改为流式 SHA-256，并新增扫描进度行。

**可访问性与批量报告**：详情抽屉改为真正的模态对话框——打开即把焦点移入面板、Tab / Shift+Tab 在
面板内首尾循环、Escape 关闭后焦点回到触发它的按钮。工具栏新增「导出批量报告」：把每张文件的
`picprivacy.report/1` 装进一个 `picprivacy.batch/1` 文档（逐条仍是完整报告，可单独取出复用），
生成过程显示 `生成报告 n / N`，期间下载按钮置灰。单测覆盖批量文档结构与文件名，e2e 验证下载内容。

**批量健壮性**：批量清理可随时取消，检查点放在限流器回调内部（在飞的那张仍做完并复检），取消后
排队项保持原状态、可再次启动。打包改为自研 store-only ZIP（`src/lib/zip.ts`）：成员是清理后 Blob
的引用而不是副本，所以 2 GB 批次的峰值内存从「整包再复制一份」降到几 KB 表头；唯一的字节遍历是
CRC-32（slicing-by-8），超过 4 GB 的经典 ZIP 上限会明确拒绝。验证换成 CPython `zipfile` 解包 ——
与我们不共享任何代码，逐成员校验 CRC，并补了一个 40 个成员的 e2e 比对「压缩包成员字节 == 单张下载」。

**TIFF（原低优先级项，已交付）**：`src/core/tiff-image.ts` 不解析像素，只重建目录——按白名单留下
结构标签，把条带（或瓦片）原样重排、重写 `StripOffsets` / `TileOffsets`，像素码流逐字节复制，
因此 LZW / Deflate / PackBits / 无压缩 / CMYK / 调色板 / 16 位都能走同一条路。描述性标签、Exif 与
GPS 子目录、XMP、IPTC、Photoshop 资源、GeoTIFF 地理参考一并删除，`Orientation` 与 ICC 保留。

多页文件按目录链逐页重建并重新链接；`NewSubfileType` 标为缩小版的目录当作缩略图整份删除；压缩方式 7
的内嵌 JPEG 条带会交给 JPEG 引擎再清一遍，只有内容真的变了才换字节。仍拒绝：BigTIFF、SubIFD、
DNG/CR2/CFA 原始格式、老式 JPEG（压缩方式 6）。校验面覆盖真实样张 `exiftool-ExifTool.tif`（LZW + IPTC）、
Pillow 十种编码变体与三页文档扫描：每页解码像素一致，描述标签清零。

**HEIC / AVIF（原第 1 项，已交付）**：`src/core/isobmff.ts` 负责盒子读写、`iloc`/`iinf`/`iref`/`ipma`
的版本与可变宽度解析；`src/core/heif.ts` 按白名单重建容器——把保留项重新打包进新的 `mdat`、
重写 `iloc` 指向它，图像码流零重编码。`Exif`、XMP `mime` item、`jumb`（C2PA）以及未知 item 一律删除，
`iref` 里指向它们的引用同步清掉。

两种格式共用同一个分析器，靠 `ftyp` 的品牌区分（`mif1` 这类通用品牌看兼容列表）。iPhone 12 Pro 样张
验证：主图 4032×3024 解码后的 RGB 逐字节一致，`irot` 保留因而方向不受影响。

已知限制：**浏览器无法解码 HEIC**（`<img>` 与 `createImageBitmap` 都失败），所以缩略图退化为图标、
悬停提示清理仍然有效；AVIF 不受影响，Chrome 正常显示。**ExifTool 的 HEIC 样张是 stub 码流**，
`tools/verify.py` 对这类文件改为比对容器声明的流布局，而不是像素。

**真实样本回归（原第 1 项）**：`tests/real.test.ts` 对 `tests/real/` 跑「扫描 → 清理 → 复检」，
`tools/verify.py` 再用 Pillow（HEIF/AVIF 用 ffmpeg）解码比对像素。`pnpm real` 按固定 commit + 逐文件
SHA-256 拉取 ExifTool 的 27 张公开样张（各厂相机、GPS/XMP/IPTC/MWG/扩展 XMP、PNG/GIF/WebP/HEIC/TIFF），
私照目录不入库，CI 跳过。这批样本已经抓出四个真 bug：空的 GPS IFD 被当成 0,0 坐标、
C2PA 2.x 清单没被识别、UTF-16 编码的 XMP 被当成空包、HEIF 的 `Exif` item 多了 4 字节偏移前缀。

**诊断报告（原第 3 项）**：详情抽屉可导出 `picprivacy.report/1`（JSON）：文件哈希、嗅探结果、全部
findings/警告/容器块、生效设置，以及清理后的 removed 与复检结果；二进制只记长度，不记内容。

**方向提示（原第 1 项）**：默认路径下，设置区会对带方向标签的文件给出警告条与一键开关；批量清理结束后
汇总里再补一句（`73b2d6c`）。

**站点可访问性（原第 5 项）**：维护者为 `www.illageraris.dpdns.org/*` 配了 Cloudflare 跳过挑战规则，
之后 `curl` 与自动化对首页、JS、CSS、`sw.js`、favicon 全部 200（此前一律 403）。仓库侧无需改动。

**运维（2026-11-11 复查）**：Pages 的 Enforce HTTPS 已打开，`http://` 现在 301 到 HTTPS；Cloudflare 的
Web Analytics / Rocket Loader 已关，线上 HTML 不再注入 beacon。HSTS 仍需在 Cloudflare 侧加
`Strict-Transport-Security`（Pages 不支持自定义响应头）。
