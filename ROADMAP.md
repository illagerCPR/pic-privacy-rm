# PicPrivacy 路线图

维护者向文档：按「收益 ÷ 代价」排序，不是承诺。动手前请对照 [AGENTS.md](AGENTS.md) 里六条不可破坏的约束。

发布日期：2026-11-01 · 基线提交 `2aa4ddf`

---

## 1. HEIC / AVIF（大）

**缺口**：iPhone 默认拍摄格式，目前明确报「不支持」。

**难点**：不能沿用 JPEG 的容器拼接模型。ISOBMFF 的 EXIF/XMP 是 `mdat` 里被 `iloc` 用**绝对偏移**引用的 item，
删掉字节就必须重写 `iinf` / `iloc` / `iref`，并保证所有 extent 自洽。
「只摘引用、不删字节」会让明文 EXIF 留在文件里（`strings` 就能取出），等于假清理，违反第一条约束。

**阶段**：

1. 解析与报告（可以先做，代价小，能先给出准确提示）
2. 重写 `iinf` / `iloc` / `iref` + 字节删除
3. 逐 extent 复检，纳入现有 verify 闸门

工作量经验估计为现有单格式的 3–5 倍。前置的真实样本通道已经就绪（见「已完成」），
`tests/real/` 里放进几张 iPhone 原图即可验证每一个阶段。

---

## 明确不做

- **视频元数据**（MP4 `udta` / `meta`）—— 范围与定位都不匹配
- **CLI 或服务端版本** —— 出离「纯前端零网络」
- **把自研解析换成第三方库** —— 会让「白名单 + 零重编码 + 自复检」这套可验证性打折

---

## 其它待办（低优先级）

`TIFF`（IFD 重写）与 `BMP` / `JXL` 支持、批量队列可取消、详情抽屉加焦点陷阱、大 ZIP 的 e2e。

## 已完成

四格式无损引擎、双语界面、单张与批量、方向烘焙开关、service worker 离线、CI 与 Pages 自动部署；
「全部元数据」视图（全量 EXIF / XMP / IPTC / C2PA 展开、厂商字节 hex 预览、清理前后双列对比）；
质量面为 80 个单测（CI）+ 32 个真实样本用例（本地）+ 11 个 Chrome e2e + Pillow 独立校验 + 离线断言。

**真实样本回归（原第 1 项）**：`tests/real.test.ts` 对 `tests/real/` 跑「扫描 → 清理 → 复检」，
`tools/verify.py` 再用 Pillow 解码比对像素。`pnpm real` 按固定 commit + 逐文件 SHA-256 拉取
ExifTool 的 27 张公开样张（各厂相机、GPS/XMP/IPTC/MWG/扩展 XMP、PNG/GIF/WebP/HEIC/TIFF），私照目录不入库，
CI 跳过。这批样本已经抓出三个真 bug：空的 GPS IFD 被当成 0,0 坐标、C2PA 2.x 清单没被识别、
UTF-16 编码的 XMP 被当成空包。

**诊断报告（原第 3 项）**：详情抽屉可导出 `picprivacy.report/1`（JSON）：文件哈希、嗅探结果、全部
findings/警告/容器块、生效设置，以及清理后的 removed 与复检结果；二进制只记长度，不记内容。

**方向提示（原第 1 项）**：默认路径下，设置区会对带方向标签的文件给出警告条与一键开关；批量清理结束后
汇总里再补一句（`73b2d6c`）。

**站点可访问性（原第 5 项）**：维护者为 `www.illageraris.dpdns.org/*` 配了 Cloudflare 跳过挑战规则，
之后 `curl` 与自动化对首页、JS、CSS、`sw.js`、favicon 全部 200（此前一律 403）。仓库侧无需改动。

顺手可做的两件运维小事：在 Pages 设置里打开 Enforce HTTPS —— 现在 301 的 `Location` 是 `http://`，
等于多一次不安全跳转；关掉 Cloudflare 的 Web Analytics / Rocket Loader —— 注入的 beacon 会被 CSP 拦下，
开发者工具里会留下 status 0 的请求，容易让「零网络」的验证者误判。
