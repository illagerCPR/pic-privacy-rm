# PicPrivacy 路线图

维护者向文档：按「收益 ÷ 代价」排序，不是承诺。动手前请对照 [AGENTS.md](AGENTS.md) 里六条不可破坏的约束。

发布日期：2026-11-01 · 基线提交 `2aa4ddf`

---

## 明确不做

- **视频元数据**（MP4 `udta` / `meta`）—— 范围与定位都不匹配
- **CLI 或服务端版本** —— 出离「纯前端零网络」
- **把自研解析换成第三方库** —— 会让「白名单 + 零重编码 + 自复检」这套可验证性打折

---

## 其它待办（低优先级）

`TIFF` 的 BigTIFF、SubIFD、老式 JPEG（压缩方式 6，目前一律拒绝而不是半清理）；`BMP` / `JXL` 支持；
`avis` 序列（带 `moov`，同样明确拒绝）；批量队列可取消；详情抽屉加焦点陷阱；大 ZIP 的内存上限与 e2e。

## 已完成

七种格式的无损引擎（JPEG / PNG / WebP / GIF、共用 ISOBMFF 栈的 HEIC / AVIF，以及 TIFF）、双语界面、
单张与批量、方向烘焙开关、service worker 离线、CI 与 Pages 自动部署；「全部元数据」视图（全量 EXIF /
XMP / IPTC / C2PA 展开、厂商字节 hex 预览、清理前后双列对比）；质量面为 **126 个单测（CI）+ 32 个
真实样本用例（本地）+ 12 个 Chrome e2e**，外加 `pnpm verify` 独立复核 43 个输出文件与离线断言。

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

顺手可做的两件运维小事：在 Pages 设置里打开 Enforce HTTPS —— 现在 301 的 `Location` 是 `http://`，
等于多一次不安全跳转；关掉 Cloudflare 的 Web Analytics / Rocket Loader —— 注入的 beacon 会被 CSP 拦下，
开发者工具里会留下 status 0 的请求，容易让「零网络」的验证者误判。
