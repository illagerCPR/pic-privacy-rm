# PicPrivacy 路线图

维护者向文档：按「收益 ÷ 代价」排序，不是承诺。动手前请对照 [AGENTS.md](AGENTS.md) 里六条不可破坏的约束。

发布日期：2026-11-01 · 基线提交 `9281e1b`

---

## 1. 默认路径上的静默破坏（小改动，建议优先）

**现状**：`bake` 默认 `false`，而方向提示只在开启烘焙时才出现 —— `src/components/Toolbar.tsx:139` 的条件是
`props.bake && props.orientationCount > 0`。

**后果**：`orientation` 为 2–8 的原图按默认流程清理后，方向标签随 EXIF 一起消失，查看器把它显示成躺倒。
此时界面上唯一的线索是文件行里排第 6 顺位（`src/lib/finding-ui.ts:17`，`order: 6`）的「方向」徽章，
超过 4 个还会折进 `+N`（`src/components/FileRow.tsx:93`）；真正的解释埋在详情抽屉里（`finding.orientation.desc`）。

**做法**：条件反转 —— `!bake && orientationCount > 0` 时给出可点击的提示条，一键开启烘焙；
批量收尾时若存在「已失去方向且未烘焙」的项，在汇总里补一句。

**验收**：新增 e2e —— 默认设置下清理 `rotated.jpg`，界面必须出现提示；开启烘焙后像素尺寸互换（已有覆盖）。

---

## 2. 真实样本回归（中等）

**现状**：`tests/fixtures/` 的 14 个文件全部由 `tools/make_fixtures.py` 合成。

**风险**：自己造数据、自己校验，容易两边犯同一个错误。目前已经踩过两次 —— Pillow 保存 JPEG 的 `Exif\0\0`
前缀、WebP `VP8X` 的标志位序，都是「夹具与实际格式认知同时偏了」。

**做法**：引入 20–30 张真实产物（ExifTool 的 `t/images`、各厂相机样张、Android/iOS 导出）。
断言只保留两条，避免和实现细节耦合：**清理后仍可解码**、**复扫无敏感 finding**。

**存放**：注意仓库体积，走 Git LFS，或用脚本按固定版本拉取到 `tests/real/`（不入库）。

**附带收益**：这是第 3 项的前置准备。

---

## 3. HEIC / AVIF（大）

**缺口**：iPhone 默认拍摄格式，目前明确报「不支持」。

**难点**：不能沿用 JPEG 的容器拼接模型。ISOBMFF 的 EXIF/XMP 是 `mdat` 里被 `iloc` 用**绝对偏移**引用的 item，
删掉字节就必须重写 `iinf` / `iloc` / `iref`，并保证所有 extent 自洽。
「只摘引用、不删字节」会让明文 EXIF 留在文件里（`strings` 就能取出），等于假清理，违反第一条约束。

**阶段**：

1. 解析与报告（可以先做，代价小，能先给出准确提示）
2. 重写 `iinf` / `iloc` / `iref` + 字节删除
3. 逐 extent 复检，纳入现有 verify 闸门

工作量经验估计为现有单格式的 3–5 倍。

---

## 4. 诊断出口（小）

**现状**：验证失败只有一句错误提示，没有任何可导出的信息。

**做法**：提供「导出扫描报告（JSON）」——含 `findings`、`removed`、`verify` 结果与格式版本。
既让用户自查，也让 bug 报告可复现。

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
质量面为 67 个单测 + 8 个 Chrome e2e + Pillow 独立校验 + 离线断言。

**站点可访问性（原第 5 项）**：维护者为 `www.illageraris.dpdns.org/*` 配了 Cloudflare 跳过挑战规则，
之后 `curl` 与自动化对首页、JS、CSS、`sw.js`、favicon 全部 200（此前一律 403）。仓库侧无需改动。

顺手可做的两件运维小事：在 Pages 设置里打开 Enforce HTTPS —— 现在 301 的 `Location` 是 `http://`，
等于多一次不安全跳转；关掉 Cloudflare 的 Web Analytics / Rocket Loader —— 注入的 beacon 会被 CSP 拦下，
开发者工具里会留下 status 0 的请求，容易让「零网络」的验证者误判。
