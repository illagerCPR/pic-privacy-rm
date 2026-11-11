# 蓝图：再做一个「纯前端、零网络」的文件处理工具

这份文档不复述 PicPrivacy 的功能，而是记录**为什么这样搭**，以及在换一个领域（新的文件格式、新的
清理目标）时哪些东西可以整段搬走、哪些必须重写。动手前先读 [AGENTS.md](AGENTS.md) 的七条约束。

## 一句话架构

> 单一 `File` 进入 → 在 Worker 里**按容器白名单**重建字节 → 独立复检 → 主线程只负责状态与下载。

没有任何一段代码需要「理解」像素或语义；所有正确性都落在两件事上：容器结构重建，以及产物复检。

## 技术栈

| 选择 | 版本 | 为什么 | 代价 |
| --- | --- | --- | --- |
| Vite | 7 | 原生 ESM、worker 打包、`define` 注入版本号、构建即产物 | — |
| React + TS strict | 19 / 5.9 | 状态机表达「每个文件的阶段」很直接；`noUncheckedIndexedAccess` 揪出大量二进制越界 | 严格模式下数组访问要写 `!` |
| 原生 `Blob` 切片拼装 | — | 零重编码的物理保证：输出就是源字节的引用 | 需要自己维护偏移 |
| Web Worker | — | 解析/重建是纯 CPU，放主线程会卡 UI | 消息边界要设计 |
| Vitest | 3 | 与 Vite 同源配置，Node 里直接跑 `.ts` | — |
| Playwright + 本机 Chrome | 1.64 | 真浏览器验证「零请求」「下载的 ZIP 能解开」 | 本地才跑 |
| pnpm | 11 | 严格依赖树；`allowBuilds` 管构建脚本白名单 | — |
| **运行时依赖** | 0 | 除 React 外没有第三方库：解析器、ZIP 写入全部自研 | 自己维护正确性 |

**没有引入的东西，以及原因**：UI 组件库（体积与样式不可控）、状态库（一个 `useState` 状态机够用）、
压缩库（会为「省几百 KB」付出一整包内存复制，见第 10 节）、国际化框架（一张 key 表 + 类型约束即可）。

## 七条不变量

这七条是本项目所有设计争论的裁判，也是移植时唯一不能改的部分：

1. **白名单，而不是黑名单**：只有「解码必需 + 色彩/结构」的片段被保留，其余（包括没见过的块）一律删。
   黑名单的问题是每年都有新元数据格式。
2. **删除不依赖解析成功**：识别 GPS 标签是为了报告；删除是结构性的。损坏的 XMP 同样整段剔除。
3. **不产出未复检的文件**：strip 之后重新扫描产物，有残留就禁止下载。
4. **默认零重编码**：输出由源 Blob 切片拼装；只有用户显式开启的「方向烘焙」才过 canvas。
5. **零网络**：构建注入 `connect-src 'none'`，`tools/check_offline.mjs` 在 CI 里拦截任何外链。
6. **限流器不可嵌套**：外层占满槽位会让内层永久等待；批处理只调用单文件入口，并发由它自己管。
7. **打包不复制字节**：归档由源 Blob 引用拼装（store-only），不要让压缩库收集输出块。

## 目录与依赖方向

```
src/core/     纯函数式容器逻辑，不碰 DOM、不碰网络、能在 Node 里直接测
  sniff.ts      魔数 → 格式
  pipeline.ts   唯一入口：scan / strip / verify 编排，注册各格式 analyser
  <format>.ts   每种容器一个文件，导出 analyzeX(source, options) → ContainerAnalysis
src/workers/  把 core 挂到 postMessage 上的薄壳
src/lib/      浏览器侧小工具：worker client、限流、ZIP、报告、格式化
src/hooks/    useWorkspace：文件列表状态机（scanning → ready → stripping → done/failed）
src/components/ 纯展示
```

依赖方向是单向的：`components → hooks → lib → core`。`core` 不允许 import 任何上层东西，也不允许
出现 `window`/`document`。这条纪律换来的是：格式引擎可以在 Node 里被单测和 Python 交叉验证。

**viewer 永远不是 gate**：`metadata.ts` / `inspect.ts` 只负责「给人看」，它们解析失败不能影响删除。

## 数据流

```
File ──scan──▶ ScanResult ──┬─▶ 界面行（格式、敏感项、字节数）
                            └─▶ strip ──▶ Blob + removed[] ──▶ verify ──▶ 禁止下载 / 允许下载
                                                                    └──▶ 报告 / ZIP
```

- **scan** 只做敏感项检测，便宜；**inspect**（全量元数据）按需触发并缓存，批量 1000 张也不会拖慢首屏。
- **strip** 输出 `Part[]`（切片或新字节）→ `Blob` 拼装，大小 = 所有 part 之和，`droppedBytes` 由差值
  推出，因此「删掉多少」永远与「产出多大」自洽。
- **verify** 用同一套 core 重新扫描产物；`leftovers` 非空即失败，UI 层不出下载按钮。
- 并发：scan 2 路，strip 1 路（确定性、内存平、速度也够）。

## 新增一种格式的清单

1. `src/core/sniff.ts`：加魔数识别，返回 `{ format, supported }`。
2. `src/core/<format>.ts`：实现 `analyzeX(source, options): Promise<ContainerAnalysis>`，
   返回 `parts`（输出）、`findings`（报告）、`blocks`（结构表）。
3. `src/core/pipeline.ts`：注册 analyser，从 `UNSUPPORTED_FORMAT_NAMES` 移除。
4. `src/core/inspect.ts` + `tag-names.ts`：让「全部元数据」视图能列出新结构。
5. `tools/make_fixtures.py`：生成带真实结构的样本（GPS、缩略图、多页、边界）。
6. `tools/verify.py`：用**独立工具**（Pillow / ffmpeg / 系统 `unzip`）解码并比对像素与元数据。
7. 单测 + e2e：至少一条「清理后仍能解码 + 敏感项清零」的端到端。
8. 文档：README 的容器表、ROADMAP 的限制段、本目录树。

**判断要不要接这个格式**：先确认本机有没有第二套工具能证伪。没有的话（比如 JXL 缺编码器、
BMP 压根没有元数据），先不做——自己写引擎、自己写校验，等于自证。

## 质量体系（这是最值得抄的部分）

四层，逐层独立，前一层的结论不被后一层信任：

| 层 | 做法 | 抓什么 |
| --- | --- | --- |
| 合成夹具 | 手写容器 + 真实结构 | 结构缺失、边界 |
| 单测 | 在 Node 里跑 core，断言 findings / 输出字节 | 逻辑回归 |
| 独立工具 | Pillow、ffmpeg、CPython `zipfile`、`unzip -t` | 「我解析器自己的 bug」 |
| 真浏览器 e2e | Playwright 打开真实 UI，检查下载物与网络 | 集成、CSP、Worker |

再加两条横向约束：

- **真实样本回归**（可选目录，不入库）：相机/手机导出，`pnpm real` 按固定 commit + 逐文件 SHA-256 拉取。
- **离线断言**：构建产物里不允许出现外部 URL，CI 里必过。

数量参考（2026-11，第二轮后）：194 个单测（CI）+ 32 个真实样本 + 26 个 Chrome e2e + 46 个输出文件的
独立复核；另有确定性模糊测试与 axe-core 无障碍审计。

## UI 规范

- **所有文案走 i18n key 表**，`zh.ts` 是 key 的唯一真相，`en.ts` 用类型约束保证不缺项——包括空状态里
  的步骤说明，不要图省事写成组件内联。
- **每个文件的阶段显式建模**（`scanning / ready / clean / unsupported / error / stripping / done / failed`），
  文案与按钮都由状态推导，避免「显示干净但其实失败」这类谎报。
- **批量可取消**：token 传进单文件任务，检查点放在限流回调内部；在飞的那张做完并复检，排队项保持原状。
- **长任务有进度**：打包、生成报告这类可能跑几秒的操作，用与批量相同的进度行，并把触发按钮置灰。
- **模态要真的是模态**：打开移入焦点、Tab 循环、Escape 关闭、关闭后焦点还给触发元素。
- **导出的 JSON 是公共格式**：先定 schema 版本（`xxx.report/1`），之后只增不改，二进制只记长度。

## 换领域时的改动清单

以「换一种文件格式」为例，真正要写的只有 `core/`：

| 文件 | 是否必须改 |
| --- | --- |
| `core/sniff.ts`、`core/<format>.ts`、`core/pipeline.ts` | 必须 |
| `core/inspect.ts`、`tag-names.ts` | 想要「全部元数据」视图就必须 |
| `core/metadata.ts` 及各格式子解析器 | 按需（复用的是 Exif/XMP/IPTC/C2PA 这些通用段） |
| `workers/`、`lib/`、`hooks/`、`components/` | 不用——它们只认识「格式无关的 Item 状态机」 |
| `tools/make_fixtures.py`、`tools/verify.py` | 必须（否则没有独立验证） |

换成「剥离文档类文件的元数据」也一样：保留状态机、白名单骨架、复检与报告，重写容器解析。

## 踩坑速查（跨项目通用）

- `Blob` 拼装是**引用**，`Uint8Array` 拼装是**复制**；大文件的峰值内存由这个选择决定。
- 索引未命中的类型（`noUncheckedIndexedAccess`）在二进制解析里不是噪音，是指针越界。
- 第三方库读自己写的格式不算验证；换一个语言、换一个库读，才算。
- 浏览器 API 的「差不多能用」要实测：HEIC 解不了、`200 OK` 不代表内容对、CID 字体/`data:` URL 也
  可能触发 CSP。
- Worker 里没有 DOM：`DOMParser`、`XMLSerializer` 都不可用，XML 要自备容错解析。
- e2e 的等待条件要写「状态消失/出现」，不要写固定 sleep；元素不存在时 locator 会等到超时才报错。
- 多下载、多标签页、service worker 缓存：本地跑通不等于线上跑通，部署后至少手工走一遍。
