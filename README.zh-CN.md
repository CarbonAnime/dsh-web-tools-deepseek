# dsh-web-tools-deepseek

[English](./README.md) · **简体中文**

[![engine](https://github.com/CarbonAnime/dsh-web-tools-deepseek/actions/workflows/engine.yml/badge.svg)](https://github.com/CarbonAnime/dsh-web-tools-deepseek/actions/workflows/engine.yml)
![license](https://img.shields.io/badge/license-MIT-blue)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**DSH**）的 `ctx.web` 能力缝接到 DeepSeek 官方的 **原生搜索 / 抓取 API**：`web_search` 走 `POST /v1/tools/search`，`web_fetch` 走 `POST /v1/tools/fetch`，不再消耗 token；工具端点失败或返回空结果时，自动回退到原生（模型）搜索提供方。

HTTP 相关的一切都在一个小 **Rust 引擎**里（`crates/engine`，约 900 KiB，通过 stdio 上的 NDJSON 与宿主通信），cordis 插件只是一层很薄的 JavaScript 桥。

```text
tool-web ──▶ ctx.web ──▶ 本插件 ──┬─▶ WebSearchProvider ─┐
                                  └─▶ WebFetchProvider  ─┤ NDJSON/stdio
                                                         ▼
                                     dsh-web-tools-deepseek(.exe)   (Rust)
                                                         │
                                   POST /v1/tools/search │ POST /v1/tools/fetch
                                                         ▼
                                               https://api.deepseek.com
```

---

## 为什么需要它，以及要花多少钱

DSH 自带的两条链路都不是这两个端点：

| | 提供方 | 原理 | 计费 |
| --- | --- | --- | --- |
| 搜索 | `deepseek-official` | **服务端工具**（`web_search_20250305`），在模型调用内执行 | **token**，检索内容会落进上下文 |
| 抓取 | `http` | 本地匿名直抓 | 免费 |

本插件把两者都换成官方专用端点：

| | 端点 | 计费 |
| --- | --- | --- |
| 搜索 | `POST /v1/tools/search` | **¥5 / 1000 次成功请求**（≈ ¥0.005/次） |
| 抓取 | `POST /v1/tools/fetch` | **¥5 / 1000 次成功请求**（≈ ¥0.005/次） |

> **只有成功的请求才计费**：HTTP 200 **且确实产生了结果**（搜索返回非空 `results`、抓取拿到正文）才算一次。403、404、空结果、超时、失败全部**免费**。`count` 只控制返回几条，**不影响单价**。详见「[计费与限制](#计费与限制)」。

换来的东西是：**可预期的按次价格取代 token 成本**，并且搜索结果以干净的结构化字段（`title` / `url` / `summary` / `date`）返回，而不是模型得自己从工具输出里解析的文本。想换回去见「[回退](#回退)」。

---

## 安装

### 从克隆目录安装

```bash
git clone https://github.com/CarbonAnime/dsh-web-tools-deepseek.git
dsh plugin --profile desktop add "/绝对/路径/dsh-web-tools-deepseek"
```

### 从 GitHub 直接安装

```bash
dsh plugin --profile desktop add "github:CarbonAnime/dsh-web-tools-deepseek"
```

### 安装动作做了两件事

包内声明了 `dsh.bundle.patch`，所以安装会把这个包追加进 `dsh.profile.bundles`，并应用它的 [`cordis.patch.yml`](./cordis.patch.yml)：

1. `- insert:` 插入插件行，向 `ctx.web` 注册 `deepseek-tools-api` 的搜索与抓取提供方；
2. **覆盖 `web` 行**，把 `searchProvider` / `fetchProvider` 都指向它。

**第 2 步不可省。** patch 的语义是**整体替换该行的 `config`**（不做深合并），所以两个键必须一起重述；而且装上本包之后同时可用的提供方会有三个（`deepseek-official` / `http` / `deepseek-tools-api`），接缝会拒绝猜一个，直接抛 `WEB_PROVIDER_AMBIGUOUS`。

**装完必须重启 DSH。** Cordis 在配置重载时会重跑 `apply()`，但插件**模块本身被 ESM 缓存**——改代码和首次挂载都需要重启进程（实测证据见「[疑难排查](#疑难排查)」）。

### 环境要求

| | |
| --- | --- |
| DSH | `@deepseek-ai/dsh-desktop` 0.2.x（依赖 `ctx.web` 提供方接缝） |
| Node | ≥ 18.17 |
| 凭据 | `$DSH_HOME/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`，或字面 `apiKey` |
| Rust | **不需要**——`bin/dsh-web-tools-deepseek-win32-x64.exe` 已随仓库提交；Linux/macOS 可自行编译或取 Release 附件 |

### 自行编译引擎

```bash
cargo build --release          # 或 npm run build:engine
node scripts/stage-engine.mjs  # → bin/dsh-web-tools-deepseek-<platform>-<arch>
```

引擎按下面的顺序探测，所以源码检出、已安装副本、打包 tarball 三种形态都能找到它：

1. `$DSH_WEB_TOOLS_DEEPSEEK_BIN`
2. 配置项 `enginePath`
3. `bin/dsh-web-tools-deepseek-<platform>-<arch>[.exe]`
4. `bin/dsh-web-tools-deepseek[.exe]`
5. `target/release/…`、`target/debug/…`（未 stage 的源码检出）

---

## 配置参考（19 项）

每一项都有可用默认值，空配置块也是合法的。覆盖项写在**本包之后**的 `cordis.patch.yml` 里：

```yaml
- id: web-tools-deepseek
  name: dsh-web-tools-deepseek
  config:
    count: 8
    qps: 4
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | `''` | 字面 Key。**不推荐**：会落在配置文件里。留空即走 `apiKeyEnv`。 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 通过 `credentials` 服务解析的凭据名，**每次调用重新解析**，所以换 Key 不需要重启。 |
| `baseURL` | `https://api.deepseek.com` | API 源；自动去掉尾部 `/`。 |
| `searchProviderId` | `deepseek-tools-api` | 搜索提供方注册 id，需与 `web.searchProvider` 一致。 |
| `fetchProviderId` | `deepseek-tools-api` | 抓取提供方注册 id，需与 `web.fetchProvider` 一致。 |
| `count` | `10` | 调用方没给 `maxResults` 时请求多少条（1–50）。**不影响单价**。 |
| `snippetSource` | `summary` | 每条来源的 `snippet` 取 API 的哪个字段：`summary`（600–800 字，官方标注「**适用于给模型阅读**」）或 `snippet`（100–200 字，「适用于前端展现」）。见下方说明。 |
| `oriQuestion` | `''` | 非空时作为 `ori_question` 发送（官方上限 128 字符，**超出自动截断**并记一条 warn，不影响搜索本身）。 |
| `localization` | `''` | 非空时作为 `localization` 发送。它要的是**IP 地址**（用来偏向该地区的搜索结果），**不是语言标签**——语言请写进 query：`lang:zh,en`。 |
| `blockedAsResult` | `true` | Fetch 的 403/404 作为**结果**返回（带明确的失败说明）；`false` 则抛错。 |
| `includeTitle` | `true` | API 返回的 `title` 作为 `# 标题` 前置到正文。 |
| `timeoutMs` | `30000` | 单次 HTTP 尝试的截止时间；`0` 关闭。 |
| `retries` | `1` | 408 / 429 / 5xx **以及传输层失败**（DNS、TLS、socket）的额外重试次数（0–5）。 |
| `qps` | `5` | 每个端点的限流。账号配额就是 search / fetch 各 5 QPS，所以不要调高。 |
| `userAgent` | `dsh-web-tools-deepseek/<版本>` | 请求头。 |
| `fallbackSearchProviderId` | `deepseek-official` | 工具端点失败或返回空结果时，改用的**另一个已注册**提供方。留空字符串关闭回退。 |
| `fallbackOn` | `both` | 何时回退：`never` / `error` / `empty` / `both`。 |
| `enginePath` | `''` | 显式指定引擎二进制路径，优先于 `bin/` 探测。 |
| `diag` | `true` | 每次 HTTP 尝试写一行诊断日志。 |

### 为什么 `snippetSource` 默认是 `summary`

官方对两个字段的定位写得非常明确：

> `snippet` —— 短摘要，与 query 相关，通常为 100～200 字符，**适用于前端展现**。
> `summary` —— 长摘要，与 query 相关，通常为 600～800 字符，**适用于给模型阅读**。

而本插件的**唯一消费者就是模型**：`tool-web` 会把 `source.snippet` 直接渲染进上下文。取 `snippet` 等于把「给前端看的一句话」喂给模型——它还得多 fetch 一次才能拿到有用信息，而那次 fetch 又要花 ¥0.005 和一次往返。所以默认取 `summary`。

代价是每条来源约 5–7 倍字符量（8 条约 5K 字符 ≈ 2K token）。想省上下文就设 `snippetSource: snippet`。

### 为什么不发 `need_content`

`need_content: true` 会让 API 把每条结果的**整页正文**塞进该条的 `content` 字段——而接缝的 `WebSource` 是封闭类型，装不下它，等于付费传输一批注定要丢掉的字节。（官方文档的 `curl` 示例里带了 `need_content: true`，很容易被误读成必填，其实不是。）要读整页正文请用 `web_fetch`，那才是它存在的意义。

---

## 行为说明

### `web_search` → `POST /v1/tools/search`

* 发送 `query` 与 `count`（调用方给了 `maxResults` 就用它，否则用 `count` 配置），`ori_question` / `localization` 非空时才带。
* 全空白 query、以及超过官方 128 字符上限的 query，**在本地直接拒绝**，一次请求都不发。字符数按 **Unicode code point** 计，不会把 emoji 切成半个代理对。
* 每条结果只映射接缝 `WebSource` 装得下的字段，API 给的 `rerank_score`、`authority`、`site_name`、`site_icon`、`content` 一律**丢弃**——不是塞进 `snippet`：带不出去的东西硬塞进去就是编造。
* `date` 校验为合法时间才产出 `publishedAt`（只留 `YYYY-MM-DD`）；`date` 为 `null` 就完全不给这个字段。
* **不设顶层 `content`**：`WebSearchResult.content` 是给模型读的成篇综述，把 N 条 `summary` 拼起来冒充综述就是编造。要读的正文由 `summary` 承担。
* `truncated` 恒为 `false`：一次请求取完，没有分页能力，就不谎报截断。
* 用调用方的 `maxResults` 作为真实上限去请求，而不是让接缝事后再截断——省掉那次浪费。

**搜索语法**原样透传（由 API 解析，本插件不改写 query）：

| 操作符 | 示例 | 说明 |
| --- | --- | --- |
| `site:` | `DeepSeek site:github.com` | 限定站点；多个用空格分隔并以 `OR` 连接：`site:github.com OR site:huggingface.co` |
| `-site:` | `DeepSeek -site:example.com` | 排除站点 |
| `-` | `DeepSeek -广告` | 排除含该关键词的网页 |
| `-"…"` | `DeepSeek -"release notes"` | 排除含该短语的网页 |
| `"…"` | `DeepSeek "精确短语"` | 精确匹配短语 |
| `lang:` | `DeepSeek lang:zh,en` | 限定语言，逗号分隔 |
| `after:` | `after:2025` / `after:2025-01-01` | 限定发布日期之后 |
| `before:` | `before:2026` / `before:2026-06-01` | 限定发布日期之前 |

### `web_fetch` → `POST /v1/tools/fetch`

* 先本地校验 URL：非空、≤ 8192 字符、可解析、必须是 `http`/`https`、必须有 host、不能带用户名密码——通过就**原样**传给引擎。
* 200 时返回 `{url, statusCode: 200, body: {kind: 'text', content}}`；API 的 `title` 会作为 `# 标题` 前置到正文，除非正文里已经有了。比较时会先**去掉 Markdown 的反斜杠转义**，因为 API 会把 `#`、`-` 转义掉。
* **403 / 404** 是官方对目标 URL 的两个判定（「被安全策略拒绝」/「未能获取可用的网页内容」），本插件把它们作为**结果**返回，正文开头带 `[FETCH FAILED — NOT PAGE CONTENT]`，并写明 URL、HTTP 状态与 API 原话。**抓取判定是结果，不是异常**：模型要求读一个页面，应该被告知「这个页面被拒了」，而不是收到一段堆栈。
* 其余非 2xx 抛携带 API `code` 的 `WebError`。

### 回退到原生搜索提供方

搜索失败或返回空结果时，可以回退到另一个已注册的提供方（默认 `deepseek-official`），由 `fallbackOn` 控制：

| `fallbackOn` | 何时回退 |
| --- | --- |
| `never` | 从不（纯工具端点行为） |
| `error` | 工具端点调用失败时 |
| `empty` | 工具端点返回 0 条来源时 |
| `both`（默认） | 两者都算 |

回退目标**每次调用**从实时注册表里解析（插件加载顺序没有保证，配置重载也可能随时替换对方提供方），而且**绝不走 `ctx.web.search()`**——那会解析回本提供方自身，造成递归；同时也拒绝选中自己。取消永远不是花钱的理由：被中止的调用直接抛错，不走回退；回退也失败时报告的是**主路径**的失败，因为那才是这次调用变得不寻常的原因。

### 并发、重试与取消

* search 与 fetch **各自独立**一个限流器（账号配额就是每端点 5 QPS），实现为**固定间隔**（`ceil(1000 / qps)` ms），不是令牌桶——桶会允许 1 秒内突发 `qps` 个请求，而那正好是服务端会用 `429` 拒绝的滑动窗口。
* `408` / `429` / `5xx` 会重试，优先遵循 `Retry-After`（上限 30 s），否则指数退避。**传输层失败也重试**：压根没收到应答，说明请求本身没有被拒绝。
* `400` / `401` / `402` / `403` / `404` / `413` **一律不重试**，与官方指引一致：「对于其它 4xx 错误，如不修改请求，请勿重试。」
* `timeoutMs` 按**每次尝试**计；调用方中止会通过 `cancel` 帧取消在途请求，并以 `WEB_ABORTED` 上报。
* 响应体是**增量读取**的，一旦超过 32 MiB 立即放弃，坏掉或恶意的端点无法耗尽内存。

---

## 架构

```text
lib/index.js        cordis 入口：配置 schema、注册、接线自检
lib/engine.js       拉起子进程 + NDJSON 分帧 + 请求/响应关联 + 崩溃重启
lib/search.js       搜索提供方：调用引擎、原生提供方回退
lib/fetch.js        抓取提供方：调用引擎
lib/credentials.js  凭据解析（每次调用重新读）
lib/diag.js         每次 HTTP 尝试一行 JSON
lib/web-error.js    与接缝同形状的 WebError
crates/engine/      Rust 引擎：HTTP、限流、重试、截止时间、字段映射
test/unit.mjs       32 条 —— JS 桥（假子进程），不花钱
test/engine.mjs     29 条 —— 真二进制 + 本地 mock HTTP 服务，不花钱
test/smoke.mjs      33 条 —— 打真实 API，约 ¥0.02
```

**为什么这么切？** 接缝是 cordis（TypeScript/JavaScript）的扩展点，插件必须是 JS。而所有与 cordis 无关的东西——HTTP 客户端、限流器、重试策略、截止时间、取消、请求载荷构造、响应字段映射——放进 Rust：一个二进制、没有需要跟着升级的运行时依赖，而且映射代码就贴着它要读的响应。

### 引擎协议

stdio 上的 NDJSON。桥写入：

```json
{"id":1,"method":"configure","params":{"baseURL":"https://api.deepseek.com","count":10}}
{"id":2,"method":"search","params":{"query":"…","maxResults":8,"apiKey":"sk-…"}}
{"id":3,"method":"fetch","params":{"url":"https://…","apiKey":"sk-…"}}
{"id":4,"method":"cancel","params":{"id":2}}
{"id":5,"method":"ping","params":{}}
{"id":6,"method":"shutdown","params":{}}
```

引擎回 `{"id":N,"ok":true,"result":…}` 或 `{"id":N,"ok":false,"error":{"code":"WEB_…","message":"…"}}`，另有主动帧 `{"event":"ready"|"log"|"call",…}`。桥要等到 `ready` 帧才认为引擎可用；`call` 事件变成诊断日志行——所以引擎自己从不需要手写日志。

引擎崩溃时，所有在途调用被拒绝，下一次调用会重新拉起一个；二进制缺失会上报为带「已探测过的路径列表」的 `WEB_PROVIDER_ERROR`，而不是崩溃。

---

## 计费与限制

官方文档：[搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search) · [Search API](https://api-docs.deepseek.com/zh-cn/api/search) · [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch)

| | |
| --- | --- |
| 价格 | 每个端点 ¥5 / 1000 次**成功**请求（≈ ¥0.005/次）。无 token 消耗。 |
| 计费条件 | HTTP 200 **且**产生了结果（搜索 `results` 非空、抓取返回正文）。 |
| 不计费 | 失败、空结果、超时、4xx/5xx。 |
| 限速 | 账号级每端点 5 QPS，search 与 fetch **相互独立**，与用哪个 Key 无关，与模型并发无关。Fetch 另有目标域名级限速。超限均返回 `429`。 |
| 结算 | 控制台用量页出现独立的 `tool-search` / `tool-fetch` 条目，**延迟 5–15 分钟**。 |

错误使用 OpenAI 兼容格式，`param` 恒为 `null`：

| 状态码 | 含义（搜索 / 抓取） | 本插件是否重试 |
| --- | --- | --- |
| `400` | 请求头或请求体不合法 | 否 |
| `401` | Key 缺失或无效 | 否 |
| `402` | 余额不足 | 否 |
| `403` | Fetch 被安全策略拒绝 | 否 |
| `404` | Fetch 未能获取可用内容 | 否 |
| `408` | 读取请求体超时 | 是 |
| `413` | 请求体过大 | 否 |
| `429` | 超过 QPS | 是，优先 `Retry-After` |
| `500` | 服务器内部错误 | 是 |
| `504` | 下游请求超时 | 是 |

---

## 测试

```bash
npm run test:unit     # 32 条 —— 不启引擎、不联网、不花钱
npm run test:engine   # 29 条 —— 真引擎 + 本地 mock 服务、不花钱
npm run test:smoke    # 33 条 —— 打真实 API，约 ¥0.02
```

* **`test/unit.mjs`** 用假子进程驱动 JS 桥：配置清洗、引擎路径探测、NDJSON 分帧（跨 chunk 的帧、无法解析的行、请求关联）、取消、崩溃重启、回退矩阵——包括「被取消的调用绝不会去花回退那一笔」。
* **`test/engine.mjs`** 拉起真实二进制打本地 mock HTTP 服务，断言文档化契约：请求载荷（不含 `need_content`、`count` 取自 `maxResults`）、`2xx`/`403`/`404` 映射、重试与 `Retry-After` 行为、固定间隔限流、取消、`maxResults` 夹紧、干净 `shutdown`。
* **`test/smoke.mjs`** 用假 cordis 上下文把插件端到端跑在 `api.deepseek.com` 上，并与**同一脚本里发的原始 HTTP 请求**逐条对照——映射 bug 无法藏在通过的断言后面。回退路径通过「把主路径指向一个关闭的端口」免费证明。

`test/smoke.mjs` 需要 `DEEPSEEK_API_KEY`（或 `$DSH_HOME/.credentials.yaml`），且**永不打印 Key**。

---

## 诊断

每次 HTTP 尝试写一行到 `%TEMP%\dsh-web-tools-deepseek.log`，同时回显到 cordis 日志：

```text
2026-10-17T02:20:11.402Z [info] [web-tools-deepseek] registered search="deepseek-tools-api" fetch="deepseek-tools-api" baseURL=https://api.deepseek.com key=credential:DEEPSEEK_API_KEY count=10 snippetSource=summary qps=5 timeoutMs=30000 retries=1 blockedAsResult=true includeTitle=true fallback=deepseek-official:both engine=… diagFile=…
2026-10-17T02:20:11.405Z [info] [web-tools-deepseek] seam row is wired to this plugin (search="deepseek-tools-api", fetch="deepseek-tools-api")
2026-10-17T02:20:11.899Z [call] {"label":"deepseek search","endpoint":"https://api.deepseek.com/v1/tools/search","status":200,"ok":true,"ms":412,"attempts":1}
```

| 环境变量 | 作用 |
| --- | --- |
| `DSH_WEB_TOOLS_DEEPSEEK_DIAG_FILE` | 换日志路径 |
| `DSH_WEB_TOOLS_DEEPSEEK_DIAG=0` | 关闭日志 |
| `DSH_WEB_TOOLS_DEEPSEEK_BIN` | 指定引擎二进制 |

**要看的第二行是接线自检。**「注册了」和「被选中」是两件事：没有 `- id: web` 覆盖时，本插件照常注册、照常打日志，却**永远不会被调用**——从外部完全看不出区别。日志若写着 *registered but NOT selected*，就是缺那条覆盖。（该自检读的是 `WebRuntime` 的 TS-`private` 字段，编译后就是普通属性；纯诊断用途，读不到会退化成 `(unset)`。）

---

## 疑难排查

| 症状 | 原因 |
| --- | --- |
| `WEB_PROVIDER_AMBIGUOUS` | 注册了多个提供方而 `web` 行没指定用哪个。补上 `- id: web` 覆盖。 |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | `web` 行指向本插件，但 `available()` 为假：凭据解析不到，或引擎二进制缺失。 |
| `[web-tools-deepseek] engine is not usable: …` | 引擎起不来；消息里列出了探测过的路径。 |
| `WEB_MISSING_CREDENTIAL` | `apiKeyEnv` 在 `$DSH_HOME/.credentials.yaml` 里解析不到值。 |
| 改了 `lib/*.js` 没反应 | 插件模块被 ESM 缓存，需重启 DSH。配置重载**确实**会重跑 `apply()`——实测追加一条真实覆盖（`qps: 4`）后启动行立刻变成 `… qps=4 …`——但模块本身不会被重新 import。只改注释更是什么都不会触发，因为解析后的配置没变。 |
| 用量页看不到 `tool-search` / `tool-fetch` | 结算延迟 5–15 分钟。 |

## 回退

1. 把 `web` 行指回默认值并去掉插件行，然后重启：

   ```yaml
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: deepseek-official
       fetchProvider: http
   ```

   两个键必须一起写：patch 整体替换 `config`，只改一个会漏掉另一个。也**不要**在删掉插件后让 `web` 行还指着 `deepseek-tools-api`，那会报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。

2. 或整包移除：

   ```bash
   dsh plugin --profile desktop remove dsh-web-tools-deepseek
   ```

3. 或在插件管理器里禁用它。

## 已知限制

* **Fetch 的 403 很常见**，连 DeepSeek 自家文档站都被拒（实测 `api-docs.deepseek.com` → `403 URL access denied`）；`zh.wikipedia.org`、`news.ycombinator.com` 实测 `404 failed to fetch URL`。官方也明说抓取结果受目标站点可用性与访问策略影响——**这是服务端的判定，不是插件 bug**。要抓这些站点就把 `fetchProvider` 换回 `http`。
* **没有分页**：一次请求最多 50 条，`truncated` 恒为 `false`。
* **没有流式与进度事件**：调用在 API 应答时一次性 resolve。
* **刻意不用 `need_content`**，所以整页正文总要再发一次 `fetch`（再花 ¥0.005）。
* **回退目标读的是接缝的私有字段**（`ctx.web.searchProviders`）。没有公开途径查找另一个提供方，而走 `ctx.web.search()` 会递归。接缝若改了那个字段名，回退会退化成「不回退」并记一条 warn，而不是让搜索坏掉。
* **仓库提交的二进制是 Windows x64**。其它平台自行编译或取 Release 附件；工作流已覆盖 Windows、Linux 与两种 macOS 架构。
* **HTTP 用 `reqwest` 的 `default-tls`**（Windows 上走 schannel），不是 rustls：rustls 的 crypto provider 需要 C 工具链和 NASM 才能编译，会让普通机器上的 `cargo build` 直接失败。
* **`dsh --profile desktop --dump-config` 不可用**（`profile "desktop" is managed exclusively by the Electron application`），所以验收证据只能靠活体行为 + 接线自检日志。

## 许可

[MIT](./LICENSE) © CarbonAnime

与 DeepSeek 官方无隶属关系。搜索与抓取 API、其价格与限制均归 DeepSeek 所有且可能变化，请以[官方文档](https://api-docs.deepseek.com/zh-cn/guides/search)为准。
