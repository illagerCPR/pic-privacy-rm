# PicPrivacy 路线图

维护者向文档：按「收益 ÷ 代价」排序，不是承诺。动手前请对照 [AGENTS.md](AGENTS.md) 里六条不可破坏的约束。

发布日期：2026-11-01 · 基线提交 `73b2d6c`

---

## 1. 真实样本回归（做了一半）

**现状**：`tests/real.test.ts` 把 `tests/real/` 里的真实产物跑一遍「扫描 → 清理 → 复检」，输出写到
`tests/output/real/`，再由 `tools/verify.py` 用 Pillow 解码、确认尺寸与像素未变。目录已 gitignore
（个人照片不入库），CI 缺省跳过；本地放进文件再跑 `pnpm test && pnpm verify` 即可。

**已覆盖**：vivo（iQOO Neo8，4080×2296，EXIF + 空 GPS 块 + IFD1 缩略图 + 310 KB APP4 + 480 字节尾部）、
微信导出（EXIF 已被微信剥离，只剩 ICC 与 24 字节尾部）、OpenAI 生成 PNG（C2PA 2.x 清单）、
iPhone 12 HEIC（正确报不支持）。

**已知收益**：这批样本第一次跑就抓出两个真 bug —— 空的 GPS IFD 被当成 0,0 坐标、C2PA 2.x 清单完全没被识别。

**还没做**：20–30 张公开语料（ExifTool `t/images`、各厂相机样张）按固定版本拉取进 `tests/real/`，
覆盖更多机型与损坏样本。断言只保留两条，避免和实现细节耦合：**清理后仍可解码**、**复扫无敏感 finding**。

**附带收益**：这是第 2 项的前置准备。

---

## 2. HEIC / AVIF（大）

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

## 3. 诊断出口（小）

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
真实样本回归通道（`tests/real/`，本地跑，Pillow 独立校验）；
质量面为 77 个单测 + 10 个 Chrome e2e + Pillow 独立校验 + 离线断言。

**方向提示（原第 1 项）**：默认路径下，设置区会对带方向标签的文件给出警告条与一键开关；批量清理结束后
汇总里再补一句（`73b2d6c`）。

**站点可访问性（原第 5 项）**：维护者为 `www.illageraris.dpdns.org/*` 配了 Cloudflare 跳过挑战规则，
之后 `curl` 与自动化对首页、JS、CSS、`sw.js`、favicon 全部 200（此前一律 403）。仓库侧无需改动。

顺手可做的两件运维小事：在 Pages 设置里打开 Enforce HTTPS —— 现在 301 的 `Location` 是 `http://`，
等于多一次不安全跳转；关掉 Cloudflare 的 Web Analytics / Rocket Loader —— 注入的 beacon 会被 CSP 拦下，
开发者工具里会留下 status 0 的请求，容易让「零网络」的验证者误判。
