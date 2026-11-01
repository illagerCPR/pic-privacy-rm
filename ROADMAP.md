# PicPrivacy 路线图

维护者向文档：按「收益 ÷ 代价」排序，不是承诺。动手前请对照 [AGENTS.md](AGENTS.md) 里六条不可破坏的约束。

发布日期：2026-11-01 · 基线提交 `2aa4ddf`

---

## 1. AVIF（小）

**缺口**：`sniff` 认得 `avif`/`avis` 品牌，但明确报「不支持」。

**为什么小**：AVIF 与 HEIC 共用同一套 ISOBMFF 容器，`src/core/isobmff.ts` 和 `src/core/heif.ts`
的重建逻辑已经就位。需要补的是：`av01` 图像项（已在白名单里）、alpha 通过 `auxl` 引用的处理、
`a1lx` 分层编码、以及 `image/avif` 的 MIME 与下载后缀。Chrome 能原生解码 AVIF，所以这一项的
预览体验反而比 HEIC 完整。

**注意**：AVIF 的 `Exif` item 同样受 `[4 字节偏移][TIFF]` 约束，`irot`/`imir` 也可能同时出现，
测试要覆盖「两项都在」的组合。

---

## 明确不做

- **视频元数据**（MP4 `udta` / `meta`）—— 范围与定位都不匹配
- **CLI 或服务端版本** —— 出离「纯前端零网络」
- **把自研解析换成第三方库** —— 会让「白名单 + 零重编码 + 自复检」这套可验证性打折

---

## 其它待办（低优先级）

`TIFF`（IFD 重写）与 `BMP` / `JXL` 支持、批量队列可取消、详情抽屉加焦点陷阱、大 ZIP 的 e2e。

## 已完成

四格式无损引擎（JPEG / PNG / WebP / GIF）、双语界面、单张与批量、方向烘焙开关、service worker 离线、
CI 与 Pages 自动部署；「全部元数据」视图（全量 EXIF / XMP / IPTC / C2PA 展开、厂商字节 hex 预览、
清理前后双列对比）；质量面为 **95 个单测（CI）+ 32 个真实样本用例（本地）+ 12 个 Chrome e2e**，
外加 `pnpm verify` 独立复核 40 个输出文件（HEIF 用 ffmpeg，其余用 Pillow）与离线断言。

**HEIC（原第 1 项，已交付）**：`src/core/isobmff.ts` 负责盒子读写、`iloc`/`iinf`/`iref`/`ipma`
的版本与可变宽度解析；`src/core/heif.ts` 按白名单重建容器——把保留项重新打包进新的 `mdat`、
重写 `iloc` 指向它，图像码流零重编码。`Exif`、XMP `mime` item、`jumb`（C2PA）以及未知 item 一律删除，
`iref` 里指向它们的引用同步清掉。iPhone 12 Pro 样张验证：主图 4032×3024 解码后的 RGB 逐字节一致，
`irot` 保留因而方向不受影响。

HEIC 的两个已知限制：**浏览器无法解码 HEIC**（`<img>` 与 `createImageBitmap` 都失败），所以缩略图
退化为图标、悬停提示清理仍然有效；**ExifTool 的 HEIC 样张是 stub 码流**，`tools/verify.py` 对这类文件
改为比对容器声明的流布局，而不是像素。

**真实样本回归（原第 1 项）**：`tests/real.test.ts` 对 `tests/real/` 跑「扫描 → 清理 → 复检」，
`tools/verify.py` 再用 Pillow（HEIF 用 ffmpeg）解码比对像素。`pnpm real` 按固定 commit + 逐文件
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
