# dsh-local-library

中文 · [English](README.en.md)

> **English** — A **local document library for DSH Desktop**: a file cabinet shared across all conversations. Files stay on your machine (nothing is uploaded); every new chat can search, read and download them through four tools (`library_list`, `library_search`, `library_read`, `library_save`), and a **Local Library** section shows up in Settings. PDF / Word / Excel / PowerPoint / images are extracted into searchable text. MIT licensed. → **[Full English README](README.en.md)**

给 DSH Desktop 用的**本地资料库**插件：一个跨会话共享的文件柜。

- **设置左栏多一个「本地资料库」分区**：拖拽上传（含整个文件夹）、检索、按类型过滤、下载、批量打包下载、改标签、删除、重建索引。
- **每个新对话天然知道它存在**：插件往系统提示词里加一段说明，并注册 4 个工具（`library_list` / `library_search` / `library_read` / `library_save`）。用户不必再说「我有一份资料」，模型自己会先来查。
- **重复检测**：同样的内容再传一次会问「覆盖 / 再存一份 / 跳过」，不会悄悄塞进两份。
- **文件只在本机**：存在 `$DSH_HOME\local-library`（默认 `%APPDATA%\dsh-desktop\harness\local-library`），不上传任何云端。
- **可检索正文**：`.md/.txt/.csv/.json/...`、`.docx`、`.xlsx`、`.pptx`、`.pdf` 会被抽成纯文本；PDF 优先用本机 PyMuPDF（能拿中文），失败回退到零依赖的流级抽取；配了视觉模型的话，图片会被描述成文字后一起参与检索。

## 装好之后长什么样

设置（左下角齿轮）→ 左栏「本地资料库」：

- 上方是拖拽区（可拖文件夹，按顶层文件夹名记一笔），带上传进度；
- 中间是搜索框 + 类型过滤 chips（全部 / PDF / Word / 表格 / PPT / 图片 / 文本），搜索支持 `kind:`、`tag:`、`after:`、`before:` 这种过滤语法；
- 列表每行：勾选框（多选后「打包下载」成 zip）、文件名与元信息、标签（点「标签」行内编辑，逗号分隔）、命中片段、**下载**、**删除**（点两次确认）；
- 底部：文件数 / 占用 / 已建索引数 / **重建索引** / 存储路径（可复制）。

对话里可以直接说「看看我资料库里关于 XX 的东西」，模型会自己调 `library_search`。

## 安装

**前提**：Windows（靠 junction 让包名可解析，不需要管理员权限）、DSH Desktop、PowerShell 7。

从仓库拉到本机，跑一条命令：

```powershell
git clone https://github.com/Fucaplos/dsh-local-library.git
cd dsh-local-library
pwsh -File install.ps1
```

装完**重启 DSH Desktop**（宿主半侧在启动时加载），**再刷新页面 F5**（客户端半侧由启动清单投递）。设置（左下角齿轮）→ 左栏应出现「本地资料库」。

脚本是**幂等**的：已经装过就只做自检，不会重复写配置。改配置前会先备份成 `cordis.patch.yml.bak-dsh-local-library-<时间戳>`。

如果 DSH 的 profile 不在默认位置（自定义了 `DSH_HOME`、或多 profile），显式传路径：

```powershell
pwsh -File install.ps1 -ProfileRoot 'D:\my-dsh\harness\profiles\web'
```

卸载（数据默认保留，加 `-PurgeData` 才连文件一起删）：

```powershell
pwsh -File uninstall.ps1
```

安装做了什么（也说明了为什么这么装）：

1. 在 `profiles\<name>\node_modules\dsh-local-library` 建一个 **junction** 指向本目录。DSH 靠包名解析插件，junction 让包名成立，同时代码留在工作区、改完重启即生效。
2. 在 `profiles\<name>\cordis.patch.yml` 已有的 `- insert:` 列表末尾加两行：
   ```yaml
   - id: dsh-local-library
     name: dsh-local-library
   ```
   `id` 必须全局唯一且与包名一致；`id: 值` 行尾绝不能写注释（商城预检会判错）。
3. 不碰 `package.json` / `pnpm-lock.yaml` / generation 投影。走 pnpm 会被 `.desktop-bin\pnpm.cmd` 的 pnpm-runner 干扰，容易把 generation 投影还原成旧状态。
4. 最后做一次包名解析自检：`dsh-local-library` 与 `dsh-local-library/client` 都要能解析到，否则宿主半侧或客户端半侧会缺一半。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半侧：HTTP 路由、4 个工具、系统提示词段、索引流水线 |
| `lib/client.js` | 客户端半侧：设置分区 UI（React，`window.__ModuleLoader__` 载入） |
| `lib/store.js` | 存储与索引：`index.json` 原子写、中文 bigram 检索打分、正文 LRU 缓存、sha256 去重、分段读 |
| `lib/extract.js` | 零依赖文本抽取：docx/xlsx/pptx 用自研 ZIP 读取器，pdf 走 FlateDecode |
| `lib/pdftext.js` | 可选：调本机 PyMuPDF 抽 PDF（中文更稳），探测不到就跳过 |
| `lib/vision.js` | 可选：图片转文字描述（OpenAI 兼容 chat/completions，默认智谱 `glm-4v-flash`） |
| `lib/zip.js` | 打包下载用的流式 ZIP 写入器（stored，UTF-8 文件名） |
| `cordis.patch.yml` | bundle 清单（`insert` 一节） |
| `install.ps1` / `uninstall.ps1` | 装/卸到 DSH profile（建 junction + 登记 patch 行） |
| `test/*.mjs` | 六套自检，见下 |
| `LICENSE` | MIT |

## HTTP 接口（同源，浏览器直接调）

前缀 `/dsh-local-library`，无需鉴权（在鉴权层之外）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/list?q=&limit=` | `{items, stats, pending}`；带 `q` 时按检索打分返回并附 `snippet`；`limit` 默认 200、上限 1000 |
| GET | `/stats` | `{root, count, bytes, bytesText, indexed}` |
| GET | `/config` | `{matchMode}`；严格匹配开关的持久化位置 |
| PUT | `/config` | body `{matchMode:"loose"\|"strict"}`，非法值回 400 |
| POST | `/upload?name=&dup=&tags=` | body 为原始字节，流式落盘；`dup` = `reject`(默认)/`keep`/`replace`；同内容重复返回 **409** 带 `duplicate` |
| PATCH | `/item?id=` | body `{name?, tags?}`，改文件名或标签 |
| POST | `/bundle` | body `{ids:[]}`，返回 zip（最多 300 个） |
| GET | `/download?id=` | 原文件回流，`content-disposition` 带 RFC5987 文件名 |
| DELETE | `/item?id=` | 删除条目与原文件 |
| POST | `/reindex?all=1` | 重跑索引；不传 `all` 只补未建索引的 |

## 工具（进系统提示词，模型每轮可见）

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `library_list` | `limit?` | 列出全部 |
| `library_search` | `query`、`limit?`、`kind?`、`tag?`、`strict?` | 检索文件名+正文+标签，返回片段与 `matchedBy`（命中来源）；`kind`/`tag` 是快捷过滤；`strict` 走严格匹配（不传则用设置页的开关） |
| `library_read` | `id` 或 `name`、`maxChars?`、`offset?` | 读正文，长文可分段续读（返回 `nextOffset`） |
| `library_save` | `name`、`content`、`tags?` | 把结论/笔记存进库 |

## 可选配置

在 profile 的 `cordis.patch.yml` 里给这个条目加 `config`（不配就是关）：

```yaml
- id: dsh-local-library
  name: dsh-local-library
  config:
    vision:
      enabled: true
      apiKey: <你的 key>
      model: glm-4v-flash          # 默认
      endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions  # 默认
```

开了之后上传的图片会被描述成一段文字存进索引，`library_search` 就能按图片内容找。

### 严格匹配（设置页开关）

中文是按两字组合（bigram）切词的，所以「不存在的词zzz」这种查询也会因为「不存 / 存在 / 在的」在别的文档里出现过而返回几条擦边结果。设置页检索框右侧的**严格匹配**开关可以收紧：

- 关（默认，宽松）：按打分排序返回，结果多但可能有擦边。
- 开（严格）：要求查询词的命中率 ≥ 60%，且查询里的英文/数字必须真的出现；整句原样出现的一律保留。

开关状态存在 `本地资料库\settings.json`（只有一个字段）：

```json
{ "matchMode": "strict" }
```

对应接口：`GET /config` 读、`PUT /config` 写（body `{"matchMode":"strict"|"loose"}`，非法值回 400）。模型侧也可以单次覆盖：`library_search({ query, strict: true })`。


## 自检

```powershell
$env:ELECTRON_NO_ASAR='1'
$node = "$env:APPDATA\dsh-desktop\harness\.desktop-bin\node.cmd"
& $node test\client.smoke.mjs        # 客户端：载入、注册分区、SSR 渲染（含列表/多选/标签/重复提示）
& $node test\plugin.smoke.mjs        # 宿主：上传→检索→分段读→标签→打包→删除→工具→提示词段
& $node test\bugfix.test.mjs         # 回归：审计出的每个 bug 一条断言（文件名 %、offset 越界、空文件打包…）
& $node test\navicon.test.mjs        # 左栏图标的假 DOM 测试（弹窗未开不查、防抖、disposer）
& $node test\cordis.integration.mjs  # 真 Cordis 容器里加载插件，断言注册物
& $node test\extract.test.mjs        # 抽取器 18 条
```

## 已知限制

- PDF 抽取两条路：PyMuPDF（准，能出中文，但要本机有 bundled python）→ 回退流级抽取（只适合 ASCII/标准编码，中文子集 CID 字体可能乱码）。扫描件没有文本层。
- 图片搜索依赖视觉模型（`config.vision`），没配就只能按文件名/标签找。
- ZIP 读取器不支持 ZIP64、加密 ZIP，不校验 CRC；单个 zip 与单条目上限 128 MiB。
- 文本类文件索引上限 4 MiB（超出截断，检索会标明 `truncated`）。
- xlsx 不还原日期序列号、公式结果与合并单元格。
- 检索是**关键词打分**（中文 bigram + 拉丁词，文件名/标签权重高），不是向量检索。
- 拖文件夹上传是平铺的（不建子目录），顶层文件夹名会写成标签，方便按来源筛。
- `tag:` 过滤是**包含**匹配：`tag:财务` 会命中「财务部」。
- ComfyUI 工作流 JSON（`.json`，>1.5KB）只留模型名、提示词、采样参数、画布尺寸、节点标题与类型，节点坐标/控件值不进正文——所以按坐标或参数数字搜不到。其他 JSON 原样入正文。
- 这个前缀路由在 DSH 鉴权层之外（设置页要能直接 fetch），所以**凡是能访问 127.0.0.1:端口 的本机进程都能读写整个库**。库是本机私有数据，不要放密钥。

## 更新记录

**0.4.0（严格匹配开关）**
- 新：设置页检索框右侧加「严格匹配」开关。之前搜「不存在的词zzz」也会返回几条——中文按 bigram 切词，「不存 / 存在 / 在的 / 的词」分别在别的文档里出现过，很难靠打分避免。现在可以一键收紧。
- 新：严格规则——查询词命中率 ≥ 60%，且查询里的英文/数字必须真的出现，整句原样出现的一律保留。
- 新：开关状态存在 `本地资料库\settings.json`（`{"matchMode":"loose"}`），接口 `GET /config` / `PUT /config`；`library_search` 新增 `strict` 参数，可以只对一次检索生效。

**0.3.1（结构化抽取 + 命中来源）**
- 新：ComfyUI 工作流 JSON 做结构化抽取，只留「模型 / 提示词 / 采样 / 画布 / 节点标题与类型」。实测 214KB 的工作流从 152,663 字压到 2,187 字，模型名和提示词照样能搜到。
- 新：`library_search` / `GET /list?q=` 返回 `matchedBy`（`body` / `name` / `both`），只命中文件名或标签时，工具里会写「按文件名/标签命中」，设置页列表也会显示这一行，不再出现「命中但没片段」的空结果。

**0.3（bug 审计轮）**
- 修：文件名含 `%` 时上传 500（`URLSearchParams` 已解码又 `decodeURIComponent` 一次）。
- 修：`library_save` 传空白文件名会静默存成「未命名」。
- 修：`GET /list` 忽略 `limit`，且把内部 `sha256` 吐给前端。
- 修：`library_read` 的 `offset` 越过末尾时返回越界提示当正文。
- 修：只选 0 字节文件打包时 404。
- 修：`reindex`/批量上传时无并发上限（改成 2 路队列）。
- 修：改名后 `ext`/`mime` 不更新，下载的 Content-Type 是旧的。
- 修：分段读与文件名截断会切断 emoji 代理对。
- 修：客户端下载中断时打包写入可能永远等 `drain`。
- 修：客户端编辑某行标签时其它行标签全部消失。
- 修：「文件太大已跳过」的提示被「已上传 N 个」覆盖。
- 修：选中超过 300 个时静默少打包，现在会说明。
- 修：`installNavIcon` 的 MutationObserver 在聊天流式输出时高频跑全局选择器（改 250ms 防抖 + 只在设置弹窗内查）。

## 许可证

[MIT](LICENSE) © 2026 Fucaplos

随便用、改、卖，保留版权声明和许可文本即可；软件按「原样」提供，作者不担责。

