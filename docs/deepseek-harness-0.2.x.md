# DeepSeek Harness 开发参考（0.2.x）

> 面向 DSH 插件开发者的技术参考。两部分：**第一部分**是 0.2.x 的实战约束与踩坑记录，**第二部分**是架构全景与定制手册。
>
> 所有代码引用均标注 `文件路径:行号`。引用 DSH 仓库时记作 `deepseek-harness/`（指 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)根目录）；本插件仓库记作 `aishell-dsh-plugins/`。
>
> 第一部分的行号指**已安装的发行包**，而非仓库源码，路径为：
>
> ```
> DSH_PKG=~/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
> ```
>
> 下文写作 `$DSH_PKG/<包名>/lib/...`。升级 DSH 后行号会漂移，按符号名重新定位。

**适用版本**：DSH `0.2.0-rc.1`（已用 `dsh --version` 确认）。DSH 处于 developer preview，API 会 break —— 升级时以 DSH 仓库的 `.agents/notes/` 和 `CHANGELOG` 为准。

---

## 目录

### 第一部分：实战约束（0.2.x）

- [A-1. 先读这节：五条硬约束](#a-1-先读这节五条硬约束)
- [A-2. HMR 事务：最容易踩的坑](#a-2-hmr-事务最容易踩的坑)
- [A-3. Settings 写入路径](#a-3-settings-写入路径)
- [A-4. 浏览器 ↔ 宿主通道：四种，选哪个](#a-4-浏览器-↔-宿主通道四种选哪个)
- [A-5. 认证围栏](#a-5-认证围栏)
- [A-6. Cordis 插件骨架](#a-6-cordis-插件骨架)
- [A-7. Config / Volatile / Schema](#a-7-config-volatile-schema)
- [A-8. 客户端插件与构建产物](#a-8-客户端插件与构建产物)
- [A-9. Slots 系统](#a-9-slots-系统)
- [A-10. Locale 与类型化 `t`](#a-10-locale-与类型化-t)
- [A-11. 类型声明合并清单](#a-11-类型声明合并清单)
- [A-12. 凭据 seam（本次未采用，但要知道）](#a-12-凭据-seam本次未采用但要知道)
- [A-13. 诊断方法论](#a-13-诊断方法论)
- [A-14. 安全：密钥处理](#a-14-安全密钥处理)
- [A-15. 测试绝不能碰真实环境](#a-15-测试绝不能碰真实环境)
- [A-16. 速查表](#a-16-速查表)

### 第二部分：架构全景

- [1. 这是什么](#1-这是什么)
- [2. 核心概念](#2-核心概念)
- [3. 仓库布局](#3-仓库布局)
- [4. Cordis 插件框架](#4-cordis-插件框架)
- [5. Profile 与 Bundle 组合系统](#5-profile-与-bundle-组合系统)
- [6. Agent Loop:运行时心脏](#6-agent-loop运行时心脏)
- [7. Session 日志:事件溯源](#7-session-日志事件溯源)
- [8. LLM 能力层](#8-llm-能力层)
- [9. 工具执行管线](#9-工具执行管线)
- [10. Capability Seam:三角色模式](#10-capability-seam三角色模式)
- [11. Scope:per-agent 注册](#11-scopeper-agent-注册)
- [12. 审批与权限](#12-审批与权限)
- [13. 沙箱与执行世界](#13-沙箱与执行世界)
- [14. Subagent 与 Workflow](#14-subagent-与-workflow)
- [15. Compaction:上下文压缩](#15-compaction上下文压缩)
- [16. Session Projection:增量状态折叠](#16-session-projection增量状态折叠)
- [17. SDK 协议](#17-sdk-协议)
- [18. Typert:跨进程类型投影](#18-typert跨进程类型投影)
- [19. Client UI 架构](#19-client-ui-架构)
- [20. 聚合 profile 机制](#20-聚合-profile-机制)
- [21. Desktop 应用](#21-desktop-应用)
- [22. Python SDK](#22-python-sdk)
- [23. 启动调用链全追踪](#23-启动调用链全追踪)
- [24. 一轮对话调用链全追踪](#24-一轮对话调用链全追踪)
- [25. 定制开发手册](#25-定制开发手册)
- [26. 工程规范与约定](#26-工程规范与约定)
- [27. 术语表](#27-术语表)

---

## A-1. 先读这节：五条硬约束

如果只读一节，读这节。这五条是**框架强制的**，违反会报错或静默出错。

### A-1.1 一个路径只能注册一条 fetch 路由

`ctx.connection.fetch.register` 的路由表是 **`path → route` 的 Map**，`methods` 是**集合**。
同一个 path 注册两次会**抛错**：

```js
// $DSH_PKG/dsh-client-connection/lib/index.js:632
registerFetchRoute(owner, route) {
  assertFetchRoute(route);
  const registered = { methods: new Set(route.methods), requestBody: route.requestBody, fetch: route.fetch };
  return owner.effect(() => {
    if (this.fetchRoutes.has(route.path))
      throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
    this.fetchRoutes.set(route.path, registered);
    return () => { this.fetchRoutes.delete(route.path); };
  }, `client-connection: ${route.path} Fetch route`);
}
```

**正确做法**：一个路径一条注册，方法合并进同一个数组。

```ts
// ✅ 对：一条注册承载 GET + POST
ctx.connection.fetch.register({
  path: ROUTE,
  methods: ['GET', 'POST'],
  requestBody: 'buffered',
  fetch: (req) => req.method === 'GET' ? handleGet() : handlePost(req),
})

// ❌ 错：第二条会抛 "is already registered"
ctx.connection.fetch.register({ path: ROUTE, methods: ['GET'], ... })
ctx.connection.fetch.register({ path: ROUTE, methods: ['POST'], ... })
```

**为什么这个错特别疼**：`register` 在 `ctx.effect` 里执行，抛错会导致**整个插件条目激活失败**——
插件静默不工作，日志只有一行 `1 entry did not activate`。本次就是因此让设置页和 chip 一起失效。

`assertFetchRoute` 另外还校验（`index.js:758`）：

```js
function assertFetchRoute(route) {
  if (endpointFromPath("/api", route.path) === undefined)
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`);
  if (route.methods.length === 0)
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`);
  if (new Set(route.methods).size !== route.methods.length)
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`);
}
```

而 `endpointFromPath` 的规则（`index.js:711`）是**比"以 /api 开头"更严**的：

```js
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return void 0;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split("/").some((segment) =>
        segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment)))
    return;
  return endpoint;
}
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;   // index.js:550
```

**所以路径必须**：
- 严格以 `/api/` 开头（`/api` 后面得有 `/` 和内容）
- 每一段非空，且只含 `A-Z a-z 0-9 _ $ . -`
- 段不能是 `.` 或 `..`

**注意 `-` 在字符集里**：`/api/aishell/credentials/clear` 合法，
但如果你想用 `/api/aishell/credential-store` 这种连字符路径，也是合法的。
反过来说，**驼峰以外的奇怪字符（如 `:`、`%`）会直接抛错**。

**这条规则也解释了为什么单个路径要一次注册**：`endpointFromPath` 解析的是**终点段**，
不是完整路径集合。

### A-1.2 不要在 `loader/volatile-update` 里回写 settings

详见 [第 2 节](#a-2-hmr-事务最容易踩的坑)。这是本次事故的直接原因。

**一句话**：该事件是**单向通知**。框架自己的插件在它里面只做内存重建，**无一回写 settings**。

### A-1.3 fetch 路由没有 DELETE

`ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'`（`dsh-client-connection/lib/types/rpc.d.ts:107`）。
删除语义要自己用 POST 表达（如 `POST <path>/clear`）。

### A-1.4 客户端请求用文档相对路径

服务端注入的 index HTML 带 `<base href="./">`：

```js
// $DSH_PKG/dsh-host-frontend-static/lib/index.js:85
return ctx.webServer.renderIndex(await readFile(distIndex, "utf8"))
  .replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="./">`);
```

所以客户端要**去掉路径开头的 `/`**，让请求落在"当前文档的相对位置"：

```ts
// ✅ 官方写法（dsh-client-file-upload/lib/client.js:62）
const FILE_UPLOAD_ROUTE = "/api/session/uploadFileBinary".slice(1);   // → "api/session/uploadFileBinary"
const PRESENT_HOST_ROUTE = PRESENT_HOST_PATH.slice(1);                // dsh-client-ui-deliverables/lib/client.js:283

// ❌ 用绝对路径会落到站点根，绕过文档相对基址
fetch('/api/aishell/credentials')
```

**为什么**：DSH web 可以挂在子路径下。文档相对路径保证请求回到"提供本页面的那个源"，
而**同源正是认证 cookie 生效的前提**。

### A-1.5 凭据不要经 settings 文档

settings 文档是**配置**，密钥是**秘密**。混在一起会导致：明文短暂落盘、需要"写完再清掉"的别扭设计、
以及 §A-2 整类时序缺陷。用 [§A-4](#a-4-浏览器-↔-宿主通道四种选哪个) 的 fetch 路由。

---

## A-2. HMR 事务：最容易踩的坑

### A-2.1 现象

```
write FAILED -> Error: HMR transactions cannot be nested
```

伴随：写入**偶发**失败；消费方间歇报"凭据不存在"；UI 状态红绿闪烁。

**关键特征**：只有**某些路径**的写入失败，另一些同样代码的写入成功。这是定位它的突破口。

### A-2.2 完整链条

```
浏览器保存
  └─ form.mutate(ns, ops)                       dsh-config-editor / dsh-settings
      └─ SettingsService.write(ns, ...)         $DSH_PKG/dsh-settings/lib/index.js:501
          └─ configEditor.edit(entry, change)
              └─ await hmr.runExclusive(run)    ← 整段 run 在 HMR 事务内
                                                    $DSH_PKG/dsh-config-editor/lib/index.js:134
                  └─ run() 内部：
                      └─ reconcileProfilePatches(...)
                          └─ fiber.ctx.emit(self, 'loader/volatile-update', paths)
                                                                ↑ 同步！
                                            $DSH_PKG/cordis-plugin-loader/lib/index.js:420
                              └─ 插件的 ctx.on('loader/volatile-update', () => settle())
                                  └─ settle() 起异步校验，.then 里调 ctx.settings.mutate
                                      └─ 又回到 configEditor.edit
                                          └─ hmr.runExclusive  ← 事务未结束 → 拒绝
```

事务守卫（`$DSH_PKG/dsh-hmr/lib/index.js:279`）：

```js
runExclusive(operation) {
  if (this.executing.getStore())
    return Promise.reject(new Error("HMR transactions cannot be nested"));
  const task = this.operations.then(async () => {
    if (this.closing) throw new Error("HMR is disposed");
    return this.executing.run(true, operation);
  });
  this.operations = task.catch(() => {});
  return task;
}
```

`executing` 是 `new AsyncLocalStorage()`（`index.js:271`）。

### A-2.2.1 这个事件的准确契约

```ts
// $DSH_PKG/cordis-plugin-loader/lib/types/index.d.ts:29
'loader/volatile-update'(paths: readonly (readonly string[])[]): void
```

两个容易记错的点：

1. **参数是"路径数组的数组"**——每个变更字段是一条 key 路径，如 `[['accessKeyId'], ['securityToken']]`，
   不是扁平字符串数组
2. **它只派发给所属 fiber**（文档原文：*dispatched to the owning fiber only*）。发射时构造了一个
   过滤用的 self context：

   ```js
   // $DSH_PKG/cordis-plugin-loader/lib/index.js:417
   const self = Object.create(fiber.ctx);
   self[Context.filter] = (owner) => owner.fiber === fiber;
   fiber.ctx.emit(self, "loader/volatile-update", paths);
   ```

   所以**别的插件收不到你的配置变更**，你只能收到自己的。想跨插件广播要用自己的事件。

   发射处在 `try/catch` 里（只记日志），且**每个值在派发前都已提交**——监听器读到的必然是最终值。

### A-2.3 为什么"延迟一下"没用

ALS 沿 **promise 续体**传播。实测结论（写过一个最小复现验证）：

| 逃逸手段 | 结果 |
|---|---|
| 直接调用 | ❌ 仍在事务内 |
| `await` 之后 | ❌ 仍在事务内 |
| `setTimeout` / `setImmediate` / `queueMicrotask` | ❌ 仍在事务内 |
| `Promise.resolve().then(...)` | ❌ 仍在事务内 |
| **事务外**构造的 `AsyncResource` + `runInAsyncScope` | ✅ **能逃出** |
| 事务**内**构造的 `AsyncResource` | ❌ 逃不出 |

```js
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
const als = new AsyncLocalStorage()
const outside = new AsyncResource('x')          // 在事务外构造

als.run(true, () => {
  als.getStore()                                 // true
  setTimeout(() => als.getStore(), 0)            // true  ← 逃不出
  outside.runInAsyncScope(() => als.getStore())  // undefined ← 逃出
})
```

**但不要用这个去绕**。它绕过的是框架**刻意设置**的守卫，属 hack。
正确做法是换通道（§A-4），或把写回挂到事务**之后**的官方事件（§A-2.4）。

### A-2.4 事务之后有什么事件可用

`dsh-settings` 的 `write()` 在 `await configEditor.edit(...)` **返回之后**调 `describe()`，
而 `describe()` 会发 `settings/document-updated`：

```js
// $DSH_PKG/dsh-settings/lib/index.js:435（在 describe() 内，edit() 已 await 完毕）
if (previous?.raw !== raw || previous.autoGenerate !== autoGenerate)
  this.ownerContext.emit("settings/document-updated", entry.options.id, revision);
```

此时 ALS 里**没有**事务（已实测确认），在此回写合法。

**事件声明**：`$DSH_PKG/dsh-settings/lib/types/types.d.ts:73`
```ts
'settings/document-updated'(ns: SettingsNamespace, revision: number): void;
```

### A-2.5 框架自己怎么用 `loader/volatile-update`

三个官方插件，全都**只做内存重建**，无一回写 settings：

```js
// dsh-llm-deepseek:2269 —— 重新计算 retry policy，必要时 replace 注册
ctx.on("loader/volatile-update", () => {
  let policy;
  try { policy = dependencies.options().retryPolicy; }
  catch (error) { ctx.logger.warn(error); return; }
  if (deepEqualJson(policy, registeredPolicy)) return;
  registration.replace([provider]);
  registeredPolicy = policy;
});

// dsh-llm-pi-ai:2624 —— 重建 facts + 确保目录存在
ctx.on("loader/volatile-update", () => {
  try { ensureRegistrationFacts(); ensureDirectory(); }
  catch (error) { ctx.logger.error(error); }
});

// dsh-client-product-analytics:109 —— 通知自己的订阅者
ctx.on("loader/volatile-update", () => {
  for (const listener of this.listeners) listener();
});
```

**判据**：这个事件是给你"配置变了，重建你的内存状态"用的，不是给你"回写配置"用的。

---

## A-3. Settings 写入路径

### A-3.1 服务端 API

```ts
// $DSH_PKG/dsh-settings/lib/types/index.d.ts
configure(presentation: {...}): void
prepareDocument(): Promise<string>
describe(options?: SettingsDescribeOptions): SettingsDescriptor[]
update(ns: string, patch: object, expectedRevision?: number): Promise<void>
replace(ns: string, section: object, expectedRevision?: number): Promise<void>
mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

三者关系（`dsh-settings/lib/index.js:470+`）：`update` 是 merge，`replace` 是"先重置再套用"，
`mutate` 是**逐字段操作**、且**只有它能指定 volatile path**：

```ts
// 操作形状（$DSH_PKG/dsh-settings/lib/types/types.d.ts:47）
type SettingsPathOpView =
  | { op: 'set';   path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }
```

`write()` 里会校验（`index.js:508-511`）：**只有 volatile 字段可写**，否则抛
`Config field "<path>" is not volatile`。

### A-3.2 `ns` 是什么

**`ns` = Loader 那一行的 `id`**，即 profile `cordis.patch.yml` 里的行 id，
也是插件 `apply()` 里 `ctx.fiber.entry?.options.id` 的值。

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: aishell-client-credentials        # ← 这个就是 ns
  name: "@huaweidevtools/aishell-dsh-client-credentials"
  config:
    credentialsStored: true
```

### A-3.3 浏览器侧：configForms

```ts
// $DSH_PKG/dsh-client-ui-settings/lib/types/client/config-form.d.ts
class ConfigFormController<T> implements ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>        // 稳定引用，uSES 安全
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>
}

class ConfigForms extends Service {
  get<T>(entryId: string): ConfigForm<T>
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
  readonly developerTools: DeveloperToolsPreference
}
```

- 返回值 `boolean` = **宿主是否接受**；`false` 表示被拒（revision 冲突等）
- **读始终合法**。非法的只有"在 volatile-update 处理器里写"
- `whileServed` = "仅当宿主确实提供该 namespace 时才注册这块 UI"，避免在没有该插件时留下痕迹

### A-3.4 revision 乐观并发

`describe()` 为每个 ns 维护 `revision`：内容或 `autoGenerate` 变化时 +1。
写入可带 `expectedRevision` 做 CAS，不匹配抛 `SettingsConflictError(ns, expected, actual)`。
浏览器侧的 `ConfigFormController` 会自动带上最近已知 revision，并在失败后恢复读。

---

## A-4. 浏览器 ↔ 宿主通道：四种，选哪个

| 通道 | 适用 | 第三方插件可用？ | 认证 |
|---|---|---|---|
| **`ctx.connection.fetch.register`** | 自定义 HTTP 端点、流式、原生响应 | ✅ **可以** | `/api` 围栏 + cookie |
| `ctx.connection.rpc.handle(prefix)` | 逻辑 RPC 通道 | ✅ 可以 | 同上 |
| Typert Remote（`@Remote` + `$mount`） | 框架内部跨进程类型投影 | ❌ **不行**（见 §A-4.2） | 同上 |
| `ctx.credentials` / `credentials/set` | 框架托管的密钥 | ⚠️ 可以，但**落点不是你的 keyring**（见 [§A-12](#a-12-凭据-seam本次未采用但要知道)） | — |

### A-4.1 `ctx.connection.fetch.register`（本次采用）

```ts
// 签名（$DSH_PKG/dsh-client-connection/lib/types/rpc.d.ts:111）
interface ConnectionFetchRoute {
  readonly path: string                                        // 必须以 /api 开头
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'               // buffered 受 JSON 上限；streaming 有背压无总量上限
  readonly fetch: (request: Request) => Promise<Response>
}
// 返回 disposer，交给 ctx.effect 管生命周期
register(route: ConnectionFetchRoute): () => Promise<void>
```

宿主侧完整写法：

```ts
export const inject = ['connection']

ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/aishell/credentials',
  methods: ['GET', 'POST'],
  requestBody: 'buffered',
  fetch: (req: Request): Promise<Response> =>
    req.method === 'GET' ? statusHandler() : saveHandler(req),
}), 'my-plugin: credentials route')
```

浏览器侧：

```ts
const ROUTE = 'api/aishell/credentials'   // 注意：无前导斜杠
const response = await fetch(ROUTE, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  // 同源请求默认带 cookie；官方插件也用 credentials:'include' 显式表达
})
```

**关键性质**：
- 路由是 **fiber-scoped**（`registerFetchRoute(owner, route)` 里 `owner.effect(...)`），
  插件重载**自动清理**，不会泄漏
- `requestBody: 'buffered'` 的请求受 `ConnectionConfig.maxRequestBodyBytes` 限制——
  **默认 300 MiB**（`DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024`，`index.js:25`）。
  超限时：有 `Content-Length` 就直接拒；分块传输则在累计字节数超限时中断（`index.js:50,61`）
- 用 `Response.json(...)` 返回；这是标准 Fetch API 的 `Response`
- `assertImageBodyCapacity`（`index.js:791`）会校验该上限不低于图片聚合限制——
  调小它可能让插件启动失败

**参考实现**：
- `dsh-client-file-upload/lib/index.js:171` — 流式上传
- `dsh-client-ui-deliverables/lib/index.js:49,55,84` — 一批 GET/POST 路由
- `dsh-api-session-controller/lib/index.js:2396` — `/api/file`
- `dsh-session-log-export/lib/index.js:516` — 带 HEAD 的下载

### A-4.2 Typert Remote：看起来对，但第三方用不了

`@deepseek-ai/dsh-typert-protocol` 提供了完整机制：
`@Remote` 装饰器、`TypertRemoteService` 基类、`TypertRemoteContribution`、`$mount(contribution)`、
`TypertRemoteRegistry.register(contribution)`……

**但走不通**：各包的 Remote 描述符是被**代码生成器**产出、并被**打进 `dsh-api-remotes` 自己的
client bundle**（源码里可见 `TYPERT_REMOTE$1` 到 `TYPERT_REMOTE$23` 等常量，
见 `dsh-api-remotes/lib/client.js`）。第三方插件**没有把自己的贡献注册进去的入口**。

```js
// dsh-api-remotes/lib/client.js:4328 起，是一长串内联的 remote 描述符
//#region ../../client/product-analytics/lib/typert.remote-client.js
const TYPERT_REMOTE$23 = { package: '...', descriptors: [...] }
```

**结论**：想在插件里加浏览器可调的自定义 API，用 §A-4.1，不要试图走 Typert。

### A-4.3 客户端如何知道自己能调什么

package.json 声明：

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"],
      "immediately": false
    }
  }
}
```

`DshClientManifest`（`$DSH_PKG/dsh-package-manifest/lib/types/types.d.ts:76`）：
- `platform`（必填）：Web 消费者选 `web`
- `inject`：**信息性的包名依赖**，不是 Cordis 服务注入
- `immediately`：boot 第一阶段注册屏障；省略 = 走共享应用批次

注意：`dsh.client.inject` 是**包名**，而 Cordis 的 `export const inject` 是**服务名**。两者不同。

---

## A-5. 认证围栏

### A-5.1 两道检查

```js
// $DSH_PKG/dsh-client-connection/lib/index.js:585
requestRejection(request) {
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
  return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
```

**先 trust 后 auth**，都在路由匹配**之前**。

```js
// index.js:205
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
```

通过条件是：**loopback 主机名**（或部署声明的 `trustedHosts`）+ **非 cross-site** + **Origin 与 Host 同源**。

### A-5.2 ⚠️ 未认证探测无法判断路由是否存在

因为围栏在路由匹配**之前**执行，一个**不存在**的 `/api/*` 路径同样返回 401：

```
GET /api/aishell/credentials    → 401
GET /api/aishell/nonexistent    → 401   ← 也是 401
```

**所以**：拿不到认证凭据时，`curl` 得到 401 **不能**证明"路由已注册"。
要验证路由存在，必须带认证（会话 cookie），或从服务端日志/进程内确认。

（这是本次踩过的一个判断错误——一度把 401 当作"注册成功"的证据。）

### A-5.3 浏览器侧如何通过

- 页面加载时通过 URL 的 `?token=...` 或 cookie 完成认证
- 会话 cookie 前缀 **`dsh-auth-`**
- 持久化记录键：`credentialKey("client-connection", "browser-session")`
- cookie 寿命默认 30 天（`cookieMaxAgeDays`）
- 之后浏览器只需**同源 fetch**，cookie 自动携带

---

## A-6. Cordis 插件骨架

### A-6.1 宿主插件

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** 插件名，也被 Loader 用作默认的 entry id。 */
export const name = 'aishell-client-credentials'
/** 依赖的服务；未就绪则不激活。 */
export const inject = ['settings', 'connection']

export const Config = z.object({
  credentialsStored: z.boolean().default(false).volatile(),
  accessKeyIdHint: z.string().default('').volatile(),
})

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  // 所有注册都包在 ctx.effect 里 —— 返回 disposer，随 fiber 卸载
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'label')
}
```

要点：
- `inject` 是**服务名**数组（`'settings'`、`'connection'`、`'llm'`…）
- `ctx.effect(fn, label)` 里 `fn` 返回 disposer；**所有注册都要走它**，否则重载会泄漏
- `ctx.fiber.entry?.options.id` = 本插件的 settings namespace（§A-3.2）
- `ctx.logger.warn/error` 而非 `console.*`

### A-6.2 `ctx.effect` 的正确用法

```ts
// 返回 disposer
ctx.effect(() => someService.subscribe(handler), 'my-plugin: subscription')

// 返回清理函数
ctx.effect(() => {
  const controller = new AbortController()
  return () => controller.abort()
}, 'my-plugin: abort on dispose')
```

**它也是错误传播的边界**：`ctx.effect` 内抛错会导致整个条目激活失败——这正是 §A-1.1
那个"路由重复注册"让插件静默失效的原因。

---

## A-7. Config / Volatile / Schema

### A-7.1 `Volatile<T>`

```ts
// $DSH_PKG/cosmokit/lib/types/volatile.d.ts:7
interface Volatile<T> {
  /** 当前不可变快照（值缺失时为 undefined）。 */
  get(): VolatileSnapshot<T>
}
```

**只有 `get()`**——没有 `set`、没有 `subscribe`。这是刻意的：volatile 引用由宿主运行时更新，
插件只能读。**更新只能通过 settings 写入路径**（§A-3）。

`VolatileSnapshot<T>` 递归 readonly。

### A-7.2 Schema 修饰符

```ts
z.object({
  plain:      z.string().default(''),            // 普通字段：改动会重挂插件
  hot:        z.string().default('').volatile(), // volatile：热更新，不重挂
  secretVal:  z.string().role('secret'),         // 脱敏：不上 wire、日志打码
})
```

- `.volatile()` → 进 volatile 集合，`loader/volatile-update` 能带它；**也是 `mutate` 唯一能写的字段**
- `.role('secret')` → `redactSecrets` 处理，`describe({redactSecrets:true})` 时替换为占位

**重要**：普通（非 volatile）字段变了会导致插件**重挂**；volatile 字段只更新引用。
`configEditor.edit` 里会检查：

```js
if (!deepEqual(fiber.config, candidate, true)) {
  this.ctx.logger.debug("ordinary config values ... changed with its volatile values; applying the ordinary update");
  return false;   // → 走重挂路径
}
```

### A-7.3 配置从哪来

优先级（`configEditor.configuration()` 返回 `{entry, inherited, override}`）：
profile patch → 继承（bundles） → 命令行 overlay。
profile 文档是**唯一可写层**；被 home patch 或 CLI 覆盖时写入会抛
`Configuration for "<id>" is overridden by a home patch or command-line overlay`。

---

## A-8. 客户端插件与构建产物

### A-8.1 产物形态

客户端半必须是包在 `window.__ModuleLoader__.load({...})` 里的 **CJS 闭包工厂**：

```js
window.__ModuleLoader__.load({
  id: "@huaweidevtools/aishell-dsh-client-credentials",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    // ... 打包后的代码 ...
    return module.exports;
  }
});
```

用 tsdown 实现（本仓库 `packages/aishell-credentials/tsdown.config.ts`）：

```ts
const BANNER = `window.__ModuleLoader__.load({ id: "@huaweidevtools/aishell-dsh-client-credentials", factory: (require) => {`
const FOOTER = 'return module.exports; } });'
const INTRO  = 'var module = { exports: {} }; var exports = module.exports;'

export default defineConfig([
  { name: 'node',   entry: ['src/index.ts'], outDir: 'lib', format: ['esm'], platform: 'node', dts: true },
  { name: 'client', entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: ['cjs'],
    platform: 'browser', external: isExternal, outputOptions: { entryFileNames: 'client.js', banner: BANNER, footer: FOOTER, intro: INTRO } },
])
```

**平台模块必须是 external**（由 shell 的模块表提供）：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

### A-8.2 package.json 的 exports

```json
{
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "platform": "web", "inject": [...] } }
}
```

**`./package.json` 必须导出**——`dsh.client` 清单是从它读的。

### A-8.3 客户端的 `inject` 是服务名

```ts
// src/client/index.ts
export const inject = ['slots', 'locale', 'configForms']
```

用 slots 要 `'slots'`；用 locale 要 `'locale'`；用 configForms 要 `'configForms'`；
要调 fetch 路由则**不需要**在客户端注入 `connection`（fetch 是纯 HTTP）。

### A-8.4 类型导入（很重要）

Cordis 用**声明合并**扩展 `Context`。要用某个服务，必须 **type-only import** 对应包把声明"拉"进来：

```ts
import type {} from '@deepseek-ai/dsh-settings'              // ctx.settings
import type {} from '@deepseek-ai/dsh-client-connection'     // ctx.connection
import type {} from '@deepseek-ai/cordis-plugin-loader'      // ctx.loader + Fiber.entry
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'    // settings.section 槽位 + ctx.configForms
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'    // ctx.slots
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client' // conversation.* 槽位
import type {} from '@deepseek-ai/dsh-client-locale/client'         // ctx.locale
```

**这类 import 不是装饰**。本次删掉 `cordis-plugin-loader` 的 import 后立刻报
`Property 'entry' does not exist on type 'Fiber'`——因为 `Fiber.entry` 正是由它合并进来的。

记得把这些包加进 `devDependencies`，否则类型解析不到。

---

## A-9. Slots 系统

### A-9.1 注册

```ts
ctx.effect(() => ctx.slots.inject('settings.section', () =>
  ctx.slots.register({
    name: 'settings.section',
    id: 'aishell',
    order: 50,
    label: () => 'AI Shell',
    locale: NS,                          // 声明后 props 上会有类型化的 t
    inject: () => ({ ...businessFace }), // 返回的对象成为组件 props 的一部分
  }, MyComponent)
), 'label')
```

`BaseOptions`（`$DSH_PKG/dsh-client-ui-slots/lib/types/index.d.ts:597`）：

| 字段 | 说明 |
|---|---|
| `name` | 目标槽位键（**必填**） |
| `id` | 条目标识，用于诊断与去重 |
| `order` | 同槽位内的排序 |
| `label` | 标签（section 类槽位用于导航） |
| `locale` | 字典命名空间；声明后组件 props 得到类型化 `t` |
| `children` | 子槽位声明 + 渲染授权 + 运行时规格，三合一 |
| `store` | store 座位：共享 handle 或独占工厂 |
| `inject` | 业务面工厂，返回值并入组件 props |
| `registrant` | 诊断用的注册者标识 |

### A-9.2 槽位类型

```ts
type SlotKind  = 'single' | 'list' | 'keyed' | 'chain'
type SlotScope = 'root' | 'session-maybe' | 'session'
```

- `single` — 单占用
- `list` — 有序列表
- `keyed` — 按 key 派发
- `chain` — 选择器路由的接管链

`scope` 决定 `inject` 工厂收到什么参数（`InjectParams`，`index.d.ts:483`）：
- `session` → `[sessionId]`（必然存在）
- `session-maybe` → `[sessionId | undefined]`
- `root` → `[]`
- 声明了 `store` 还会追加 `actions`

### A-9.2.1 ⚠️ `priority`：越低越优先（最容易出错的一处）

**`single` 槽渲染优先级「最低」的那个注册，默认值是 0。**
来源（`dsh-client-ui-slots/lib/index.js`）：排序是升序，`entries[0]` 即 winner；

```js
next.sort(spec.kind === 'list'
  ? (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0) || (a.options.order ?? 0) - (b.options.order ?? 0)
  : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
```

配套约束：

| 事实 | 后果 |
|---|---|
| `single` 槽是**升序取第一个** | 写入正值（如 `30`）**永远输给任何 ≤0 的注册者** |
| 同优先级**不能有两个** `single` 注册 | 重复会抛 `single slot "..." already has a registration` |
| 报错原文写着 `lowest renders` | 出错时按这句理解，别按直觉 |

**失败形态很隐蔽**：占位被别人拿着时，`register()` **照常返回 disposer**，
只是组件**永远不渲染**——因此它的 `inject` 工厂**永不执行**，注册期间没有任何异常。
诊断信号就是这个不对称："注册成功" + "inject 从未触发" ⇒ 先查 priority。

- 想抢过默认（0）或官方实现：用 **负数**（`aishell-brand` 用 `-1` 抢官方 brand）
- 想排在别人后面：**不要靠 priority**，用 flex 的 `order`（见 §A-9.2.2）
- `list` 槽才用 `id` + `order`；`single` 槽只认 `priority`（写 `id` 会 TS 报错）

### A-9.2.2 视觉顺序 ≠ 注册顺序

槽位在容器里的**位置由父组件的 JSX 写死**，注册者改不了。
要在兄弟元素之间换位，用 flex 的 `order`（组件自己的 style 就行，不用碰 DOM）：

```tsx
// hero 行里排在 agentPreset（order 默认 0）之后
<div style={{ order: 1, flex: 'none' }}>...</div>
```

**别用 `marginLeft: 'auto'` 做这件事**：它会把剩余空间全部吸走，
元素被顶到容器最边缘、与相邻元素之间出现一大段空白。
除非要的就是"贴容器右端"，否则用 `order` + 容器自身的 `gap`。

### A-9.3 已声明的槽位键（节选）

**Conversation**（`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`）：

| 槽位 | kind | scope | 备注 |
|---|---|---|---|
| `conversation.composer.dock` | list | session | 输入框**下方**的环境条目 |
| `conversation.input.dock` | list | session | 输入卡片**上方**的全宽条目 |
| `conversation.input.overlay` | list | session | 卡片**内部**的浮动条目 |
| `conversation.input.left` / `.right` | list | session | 工具行左右控件 |
| `conversation.input.model` / `.plan` / `.permission` | single | session | 工具行命名控件 |
| `conversation.input.activity` | single | session | 模型选择器之后、可展开 |
| `conversation.composer.bar` | single | session-maybe | 常驻输入体（hero 也渲染） |
| `conversation.hero.brand.mark` | single | root | 空白会话的 brand 标记 |
| `conversation.hero.workspace` | single | root | 空白会话的工作区选择 |
| `conversation.hero.agentPreset` | single | session-maybe | 新会话的 preset 控件 |
| `conversation.header.leading` | single | root | 会话标题前的全局导航 |
| `conversation.session.header.actions` / `.utilities` | list | session | 标题旁操作 |
| `conversation.session.header.corner` | single | session | 头部最右角 |
| `conversation.view` | list | session | 会话视图 |

**Settings**（`dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`，全部 `root` scope）：

| 槽位 | kind | 用途 |
|---|---|---|
| `settings.section` | list | **一个设置页**。注册项带 `id`(section key，驱动 `only` 过滤)、`order`、`label` |
| `settings.trigger` | single | 侧栏底部触发器内容（图标 + 标签） |
| `settings.launcher` | single | 可选的侧栏账号启动器 |
| `settings.header` | single | 面板标题文本位 |
| `settings.action` | list | 内容列头部、Close 之前的操作 |
| `settings.close` | single | 关闭按钮的无障碍标签文本 |
| `settings.plugins.tab` | list | Plugins 分区内的一个页签 |
| `settings.onboarding` | list | 引导步骤 |
| `settings.general.item` | list | General 分区内的一行偏好 |

`SettingsSectionOwnerProps`（`slots.d.ts:154`）只给 `{ close: () => void }`——
**分区内容全部由你自己渲染**，包括标题。所以注册项要给 `label`，组件里也要自己画 `<h2>`。

侧栏设置触发器在 `sidebar.settings`（由 `dsh-client-ui-sidebar` 声明）。
「点击外部按钮打开设置」没有公开 API——设置面板的开关状态是 `SettingsRoot` 组件内部的。
实践做法是模拟点击 `[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]`
（用 slot key + ARIA 选择器，而不是 CSS-module 类名）。

### A-9.4 ⚠️ `conversation.composer.dock` 只在有会话时渲染

它的 `scope` 是 `session`，所以**空白/hero 页面不会渲染**。
需要"首页也显示"就要换槽位（如 `conversation.hero.*`，那些是 root scope）。

**hero 与 composer 的区别**：`conversation.composer.bar` 的 owner props 里有
`variant: 'hero' | 'composer'` 与 `phase: 'settling' | 'hero' | 'active'`——
需要在两种形态下都工作就挂 bar 级别的槽位。

### A-9.4.1 ⚠️ `scope` 不是渲染的全部条件——还有硬编码守卫

`scope` 只说"需不需要会话"，**真正的渲染还受父组件 JSX 里的条件约束**。
空白会话下这一整排都**不渲染**（`InputBar`）：

```jsx
{variant === "composer" && input !== void 0 && sessionId !== void 0
   ? renderSlot("conversation.composer.dock", {}) : null}
{sessionId === void 0 ? null : renderSlot("conversation.input.right", {})}
{sessionId === void 0 ? null : renderSlot("conversation.input.model", {...})}
```

而 `variant` 由这里决定：`variant: hero ? "hero" : "composer"`。
**所以 `composer.dock` 在空白会话下是 `variant === "hero"` 把它挡掉的**——
即使那个容器本身是渲染的。

**结论**：空白会话下可用的槽位只有 `conversation.hero.*`
（`brand.mark` / `workspace` / `agentPreset`，**全是 `single`**），
`conversation.header`（`session-maybe`），以及 `conversation.composer.bar`（`session-maybe`，但那是整个输入体，接管即替换）。

**想要"输入框下方 + 空白会话可见"是做不到的**：那个位置是 `InputBar` 的
`dock` div（`ContextMeter` 也住在里面），而它里面的槽全被 `sessionId` 守卫。
只剩 DOM 注入一条路——见 §A-9.4.2 的代价。

### A-9.4.2 ⚠️ `heroWorkspaceRow` 的真实结构

空白会话那一行（`workspace` + `Standard mode` 所在）是：

```jsx
heroWorkspaceRow = (
  <div className="heroWorkspaceRow">        // display:flex; gap:2px; padding:0 16px 0 20px
    <WorkspaceChip />                        // 硬编码组件，不占槽位
    {renderSlot("conversation.hero.workspace", {...})}   // 空槽（0.2.0-rc.1 无人注册）
    {renderSlot("conversation.hero.agentPreset", {})}    // "Standard mode"
  </div>
)
```

要点：

- 那个 **`WorkspaceChip` 是硬编码的**，不是 `hero.workspace` 槽；槽是**选择菜单**的座位
- `hero.workspace` 收的是 **workspace picker 的 props**（`open`/`anchorRef`/`selectedId`/`onPick`/`onClose`），
  占用它就得忽略这些 props（我们不需要它们）
- **这一行没有"最右边"的空位**——最后一个位置被 `agentPreset` 占着

### A-9.5 组件 props 的拼装

```ts
type ComposedProps<K, EntryKey, S, H, I, M, N> =
  & PropsRuntime<K, EntryKey>     // 槽位自身 + 标准 props（按 scope 变化）
  & PropsRenderSlots<S>           // 子槽位渲染
  & PropsRenderFactories
  & PropsStore<H>                 // 声明的 store handle
  & InjectFace<I>                 // 你的业务面
  & MatchedShare<...>
  & PropsLocale<N>                // 声明的 locale → t
```

常写字面量：

```ts
export type MyProps =
  & PropsRuntime<'settings.section'>
  & InjectFace<MyInjected>
// 需要 t 时再加 & PropsLocale<'my-ns'>
```

**`InjectFace` 会把 `hooks` 字段特殊处理**：`inject: () => ({ hooks: { x: store } })`
会被转成组件 props 上的 `useX` 选择器 hook。这是框架的约定：

```ts
interface MyInjected {
  hooks: { credentials: SnapshotStore<Status> }
}
// 组件里：props.useCredentials(s => s)
```

---

## A-10. Locale 与类型化 `t`

### A-10.1 注册与绑定

```ts
ctx.effect(() => ctx.locale.register('aishell', { zh, en }), 'dicts')
const t = ctx.locale.bind('aishell')
```

**类型化形式要求两份字典齐全**（`BuiltInLocaleId = 'zh' | 'en'`，
见 `dsh-client-locale/lib/types/locale-settings.d.ts:10`），
且 key 集合必须与 `LocaleNamespaceMap` 声明**完全一致**——多一个少一个都是编译错误。
这是"双语平衡"的强制。

### A-10.2 声明合并

```ts
// packages/aishell-credentials/src/client/locales.ts
export const NS = 'aishell' as const
export const zh = { 'account.unconfigured': '未配置凭据' } as const
export const en = { 'account.unconfigured': 'No credentials' } as const
export type AishellLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { aishell: AishellLocaleKey }
}
```

之后 `PropsLocale<'aishell'>` 就解析出类型化的 `t`。

### A-10.3 回退链

查找顺序：**当前语言** → 该语言的 `fallback` 链 → 同一个 key 在 **`common`** 命名空间重走一遍 → 显示 key 本身。
英语既是默认回退语言，也是浏览器未指定语言时的初始语言。

### A-10.4 `t` 的两个来源

- **组件 props 的 `t`**：注册时声明 `locale: NS`，框架合成
- **注入的 `t`**：`ctx.locale.bind(NS)`，返回引用**稳定**（重复 bind 返回同一函数），
  可以放进 inject 面而不破坏记忆化

---

## A-11. 类型声明合并清单

Cordis 的扩展全靠声明合并。**用之前先 import**：

| 你想用 | import 这个 | 得到的 |
|---|---|---|
| `ctx.settings` | `@deepseek-ai/dsh-settings` | SettingsService |
| `ctx.connection` | `@deepseek-ai/dsh-client-connection` | HostConnectionHandle |
| `ctx.credentials` | `@deepseek-ai/dsh-credentials` | CredentialProvider |
| `ctx.loader` / `Fiber.entry` | `@deepseek-ai/cordis-plugin-loader` | Loader / Entry |
| `ctx.hmr` | `@deepseek-ai/dsh-hmr` | Hmr（含 `runExclusive`） |
| `ctx.configForms` | `@deepseek-ai/dsh-client-ui-settings/client` | ConfigForms |
| `ctx.slots` | `@deepseek-ai/dsh-client-ui-renderer/client` | SlotRegistry |
| `ctx.locale` | `@deepseek-ai/dsh-client-locale/client` | LocaleRuntime |
| `SlotMap['settings.section']` | `@deepseek-ai/dsh-client-ui-settings/client` | 槽位契约 |
| `SlotMap['conversation.*']` | `@deepseek-ai/dsh-client-ui-conversation/client` | 槽位契约 |
| `LocaleNamespaceMap['common']` | `@deepseek-ai/dsh-client-locale/client` | 共享词表 |

写法统一为 `import type {} from '<包>'`（type-only，不产生运行时依赖）。

### A-11.1 事件也在合并表里

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/config-update'(): void
    'loader/entry-init'(entry: Entry): void
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void   // 只发给所属 fiber
    'loader/patch-context'(entry: Entry, next: () => void): void             // waterfall
    'settings/document-updated'(ns: SettingsNamespace, revision: number): void
    'credentials/reference-updated'(ref: CredentialRef): void
    'credentials/record-updated'(key: CredentialKey): void
    'locale/change'(snapshot: LocaleSnapshot): void
    'hmr/change'(url: string): void
    'hmr/reload'(reloads: Map<Plugin, Reload>): void
    'connection/request'(request, response, next): Promise<void>             // waterfall
  }
}
```

事件的 `@mode` 语义（JSDoc 里标注）：
- `emit` — 普通广播
- `waterfall` — 可拦截/改写，需调 `next()`
- `parallel` — 并行

**监听器失败是**contained**的**：sync throw 和 async rejection 都被记录而**不影响已提交操作的结果**——
除了 `INVARIANT` 编码的失败会重抛。所以别指望用监听器里的异常去回滚操作。

---

## A-12. 凭据 seam（本次未采用，但要知道）

`@deepseek-ai/dsh-credentials` 提供 `ctx.credentials`（抽象类 `CredentialProvider`）。
**两套互不相通的关键字空间**：

| 关键字 | 语义 |
|---|---|
| `CredentialRef` | POSIX 环境变量名，如 `DEEPSEEK_API_KEY`。回答"这个名字背后是什么值" |
| `CredentialKey` | `<scope>/<id>`，`scope` 是拥有者插件名。回答"这个插件为这个 id 持有什么" |

主要方法：`resolve` / `describe` / `set` / `unset` / `readRecord` / `describeRecord` /
`listRecords` / `modifyRecord` / `deleteRecord`。

### A-12.1 浏览器可直接调

`dsh-api-settings-controller` 导出了 Remote 命名空间（`typert.remote-client.d.ts`）：

```ts
interface TypertRemoteNamespaceMap {
  'credentials': {
    describe: (refs: string[]) => Promise<RemoteResult<Record<string, CredentialInfo>>>
    set: (ref: string, value: string) => Promise<RemoteResult<void>>
    unset: (ref: string) => Promise<RemoteResult<void>>
  }
  'settings': {
    describe, mutate, replace, update, openSettingsDocument
  }
}
```

官方 Models 页就是这么存 provider key 的
（`dsh-client-ui-settings-models/lib/client.js:2784`）：

```js
const response = await ctx.remote.credentials.set(ref, value)
```

页面在 `inject` 里声明 `'remote.credentials'`、`'remote.settings'` 等。

### A-12.2 落点在哪 ← **决定性的**

`dsh-credentials-local` 是 `dsh-base` bundle 的组成部分
（`dsh-base/cordis.patch.yml:118`），它把值写到：

```
$DSH_HOME/.credentials.yaml      （版本 1，mode 600，provider 管理的可写源）
  > <cwd>/.env                    （只读回退）
  > $DSH_HOME/.env                （只读回退）
```

写入走 `withFileLock` + `writeFileAtomic`，**文件里只有凭据**（不是 dotenv 格式）。

**所以**：如果你要把密钥存到**自己的** keyring（而不是框架的 `.credentials.yaml`），
这条通道不适用——用 [§A-4.1](#a-41-ctxconnectionfetchregister本次采用) 的 fetch 路由。

---

## A-13. 诊断方法论

### A-13.1 ALS 上下文的探针

想知道某段代码是否在 HMR 事务内：

```js
import { AsyncLocalStorage } from 'node:async_hooks'
// 在插件 apply() 里，通过 ctx.get('hmr') 拿到实例后探测
const storing = ctx.get('hmr')?.executing?.getStore?.()
```

更通用的做法：任何 ALS 守卫都可以用"在事务外构造 `AsyncResource`"来对照验证（§A-2.3）。

### A-13.2 `loader/volatile-update` 里打日志

这是定位"哪条写入路径失败"最有效的探针。本次就是靠它发现：
**`apply()` 里的写入成功，只有 volatile-update 里的失败**——由此锁定链条。

**记得事后删掉探针**。

### A-13.3 插件"静默不工作"

先找日志里的：
```
warning: N entry did not activate
<plugin-name> (<package>): Error: ...
```
`ctx.effect` 内抛错会让整个条目失效，但**不会**让进程退出——很容易被忽略。

### A-13.4 401 不能证明路由存在

见 [§A-5.2](#a-52-未认证探测无法判断路由是否存在)。必须带认证才能验证路由。

### A-13.5 验证插件是否真的生效

- 符号链接安装 + `patchReload: live` 时，改源码后宿主半会热重载
- 客户端半需要**浏览器刷新**
- 检查 `lib/` 产物是否真的更新了（`grep` 关键字符串），不要假设构建成功就等于产物变了

`plugin-spec`：DSH 实际加载的是**构建产物**（`lib/client.js`），不是 `src/`。
profile 里的 `node_modules/@huaweidevtools/*` 是符号链接指向工作区，所以构建后
**文件是新的、但浏览器里跑的还是旧代码**——除非强刷。
判断方法：F12 → Network → 搜 `client.js` → Response 里 grep 你要的字符串。

### A-13.6 注册成功但组件不渲染——按这个顺序查

这个症状**没有任何异常**，只表现为"元素不出现"。按代价从低到高：

1. **浏览器加载的是旧 bundle** → 强刷（Ctrl+Shift+R）；§A-13.5 的 grep 法确认
2. **`priority` 写成了正数**（§A-9.2.1）——最容易被忽略的一条。
   决定性信号：在 `inject` 工厂里放一个 `console.info`，
   **回调不触发**就说明占位不是我们（注册本身是成功的）
3. **父组件的守卫**（§A-9.4.1）——`variant` / `sessionId` / `input` 之类
4. 真到这一步再怀疑组件自身（宽度 0、被 `overflow` 裁掉等）

**探针放 `inject` 工厂里比放组件里更有信息量**：`register()` 返回 disposer 只说明
"注册被接受"，而 `inject` 工厂只在**框架真的渲染这个槽位**时才调用。
两者分开看，就能把"没注册上"和"注册了但没被选中"区分开。

### A-13.7 读框架代码时别跳过条件行

本次两次判断错误的共同形态：**读了函数体，跳过了决定它的那一行**。

- 看到 `{activity ? null : <ContextMeter />}` 就断定"那个位置有东西"，
  漏了 `ContextMeter` 内部的 `if (context === null) return null`
- 看到 `priority` 字段存在就按直觉用正值，漏了 `lowest renders` 那句提示

**做法**：结论要落到"哪一行决定了它"，而且要能把那行贴出来。
从结构相似推断（"X 和 Y 结构一样，所以行为一样"）在这套框架里不可靠——
`single`/`list` 的 priority 语义就是相反的。

### A-13.8 浏览器半边不能有 class 私有字段（`#x`）

**症状**：`pnpm run build:bundle` 看起来像卡住（几分钟不返回），产物 `lib/client.js`
消失，DSH 启动直接失败：

```
dsh: startup failed: 1 required plugin did not activate
  client-modules: 1 client package failed to compose:
    client bundles not found; run `pnpm run build` before launch
      path: packages/aishell-credentials/lib/client.js
```

**根因**：tsdown 用 oxc 编译，**oxc 处理 class 私有字段时会 panic**：

```
thread 'tokio-runtime-worker' panicked at
  oxc_transformer-0.67.0/src/es2022/class_properties/class_details.rs:138:9:
  internal error: entered unreachable code
```

Rust 侧 panic 后进程不退出 → 表现为"卡住"；而 tsdown 构建前会 `Cleaning N files`，
清理与写入之间被拉长，`lib/` 就处于**只剩宿主半边**的残缺状态。

**注意**：ESM（`lib/index.js`）和 CJS（`lib/client.js`）是两条独立管线，
**ESM 会成功、CJS 会崩**——所以 `lib/index.js` 是新的、`lib/client.js` 是旧的或不存在。
只看"构建有没有报错"会漏掉，因为输出里 `[ESM] Build complete` 照常打印。

**做法**：浏览器半边（`src/client/`）一律用**工厂闭包**，不用 class。
本仓库既有风格本来就是这样（`createCredentialPrompter`、`createPermissionRoutes`、
`createCredentialFormVisibility`），照抄即可：

```ts
export interface Thing { readonly doIt: () => void }
export function createThing(dep: Dep): Thing {
  let state: X | undefined          // 代替 #state
  return { doIt: () => { /* 闭包捕获 */ } }
}
```

需要运行时判别时用**标签 + 类型守卫**，不要 `instanceof`：

```ts
export function isCredentialForm(v: unknown): v is CredentialFormInteraction {
  return (v as { kind?: unknown } | null | undefined)?.kind === 'aishell-credential-form'
}
```

**排查手法**：构建后**一定检查 `lib/client.js` 是否存在且是新的**，不能只看退出码：

```sh
ls -l packages/<pkg>/lib/client.js     # 存在？mtime 是刚才？
```

构建耗时异常（>30s，正常约 1s）就是 panic 的信号，立刻停掉，别等。

---

## A-14. 安全：密钥处理

### A-14.1 原则

1. **密钥不进 settings 文档**（§A-1.5）
2. **校验通过才入库**——错误凭据不得落入任何持久层
3. **响应体永不带密钥**——状态端点只返回"是否已配置 + 账号名"
4. **密钥不进日志、不进对话上下文**

### A-14.2 写测试来钉住这些性质

这些是**行为契约**，要断言在 `Response` 上：

```ts
it('stores nothing when verification rejects', async () => {
  const response = await routes.save(saveRequest(GOOD))
  expect(response.status).toBe(422)
  expect(store.get('HW_ACCESS_KEY')).toBeUndefined()   // ← 关键断言
})

it('never returns a secret in the status view', async () => {
  await routes.save(saveRequest({ ...GOOD, securityToken: 'sts-token' }))
  const text = await (await routes.get()).text()
  expect(text).not.toContain(GOOD.accessKeyId)          // ← 断言字节
  expect(text).not.toContain('sts-token')
})
```

把路由处理逻辑抽成**依赖注入的工厂函数**（`createCredentialRoutes(deps)`），
就能用真实 `Request`/`Response` 直接测，不必启动整个宿主。

### A-14.3 keyring 的真实边界（如实说清）

本机用的 OS keyring 后端经 D-Bus secret service，条目在 `service=aishell-dsh` 下，
**不在任何配置文件里**。可用 `secret-tool` 查询：

```sh
secret-tool search --all service aishell-dsh        # ⚠️ 会打印 secret 值！
secret-tool search --all service aishell-dsh 2>&1 | grep '^attribute.username'   # 只看条目名
secret-tool clear service aishell-dsh username TEST  # 删除
```

**边界要说清**：这对"LLM 主动去翻凭据"是**有效隔离**（密钥不进上下文、不进配置文件、
状态端点无字段可承载），但**不是**针对本机同用户进程的**加密边界**——
同一用户会话下 `secret-tool` 可读。

**注意**：跑 `secret-tool search` 会把 secret 打到终端，被日志/工具输出捕获。
只查条目名时务必过滤。

### A-14.4 凭据存储后端链

`createCredentialsStore()` 按优先级探测，返回第一个可用的：

```
KeyringBackend（OS keyring，跨进程持久）
  → FingerprintBackend（机器指纹加密文件，同机持久）
    → MemoryBackend（进程内存，易失）
```

API 是**同步**的：`get` / `set` / `delete` / `has`。默认 service 名 `'aishell-dsh'`。

**写失败降级（FailoverStore）**：构造期探测只能发现"读不通"（`getPassword`
抛错），发现不了"读得通但写不进"。实测（隔离 D-Bus 会话）：

| secret service 状态 | 读探测 | 写入 |
|---|---|---|
| **无会话总线**（`DBUS_SESSION_BUS_ADDRESS` 与 `XDG_RUNTIME_DIR` 均未设） | **构造期即抛**（约 0.2ms）→ 工厂退到 FingerprintBackend，不会构造出 KeyringBackend | —（到不了写入这一档） |
| 有服务但无该条目 | null，约 15ms | 正常写入 |
| default 别名指向**锁定**集合（真实桌面） | null | **弹系统解锁框，阻塞至用户响应**；取消后抛 `unlock prompt was dismissed` |

（第一行是 `secret-service` 被强制之后的行为，见 `keyring.ts`；强制之前它会被
原生库静默接住并落到 kernel keyring，那一档在 headless 下会给出一个重启即失的
"成功"，是本仓修掉的问题。）

所以 keyring 通过构造探测后会被包进 `FailoverStore`：首次 `set`/`delete`
失败（锁定钥匙环对**两者**都抛错，且保存路由先 delete 后 set）即**粘性**降级
到 FingerprintBackend，**该 store 实例**之后不再碰 keyring）。
**不要**改成"构造时真写入探测"——锁定态会每次启动弹解锁框。

**为什么读不能简单地优先 keyring（踩过）**：锁定集合对**存在**的条目也返回
`null`，所以它的副本可能严重过期却看着像权威。等它解锁，这份旧值会盖过用户
期间保存的新值——**把用户已经轮换或已清除的凭据复活**，之后每次签名都用那把
作废的 AK。实测三条序列（`keyring.spec.ts` 已钉住）：锁定态 clear 后解锁 →
旧值回来；锁定态保存新值后解锁 → 读到旧值；`set` 降级写入后解锁 → 同样读旧值。

两个后端无法比新旧（谁都不记时间戳），所以规则是**fallback 对它有意见的账号
说了算**：

- fallback 里**有值** → 用它（它在那儿就说明发生过一次降级写入，按定义比
  keyring 的副本新）。不需要额外记账，值本身就把 primary 遮住了。
- fallback 里**有删除墓碑** → 视为已删除。降级态的 clear 没有值可以遮 primary，
  所以写一条显式墓碑；否则那份过期副本会读成"还在"。
- 两者都没有 → 交给 primary（正常健康路径）。

primary 写/删成功 → 同时清掉 fallback 的值**和**墓碑，权威交还 keyring。
**墓碑必须和值一起清**：只清值不清墓碑，会让一把好端端存在 keyring 里的凭据
读成"不存在"（这一条也钉了用例）。

**为什么墓碑必须落盘，不能放内存**：故障是"现在锁着"，而复活的读发生在
**下一个会话**、钥匙环已解锁之后——进程内的 `Set` 到那时已经没了。墓碑是
fallback 里 `\u0000aishell:tombstone:<account>` 一条，NUL 前缀不可能和真实账号名
冲突。代价：健康机器上 fallback 文件不存在，每次读两次亚毫秒 `existsSync`
未命中；唯一一次性开销是 fallback 改为**首次读**时构造（约 75-97ms，几乎全是
FingerprintBackend 的 scrypt 探测）。

**真实机器实测（本机：KDE + Wayland + ksecretd）**：`org.freedesktop.secrets`
由 **ksecretd**（`session-2.scope`）持有，`kwalletd6` 只做
`org.kde.kwalletd*` 后端，portal 是
`org.freedesktop.impl.portal.desktop.kwallet`；钱包文件在
`~/.local/share/kwalletd/{kdewallet.kwl,kdewallet.salt,kdewallet_attributes.json}`；
`pam_kwallet5.so` 已安装、`PAM_KWALLET5_LOGIN=/run/user/1000/kwallet5.socket`。
**`~/.local/share/keyrings/` 不存在**——GNOME/libsecret 那套路径和排查命令在
KDE 上全部不适用，别照抄。

排查 KDE 写入是否真的可用：`ls ~/.local/share/kwalletd/`；
`busctl --user list | grep -iE 'secret|kwallet'` 看谁持有
`org.freedesktop.secrets`；`grep -rn kwallet /etc/pam.d/` 看是否自动解锁。
**密钥环为什么会锁**（决定 failover 会不会被触发）：
(a) 进程不在桌面会话的 PAM 会话里——ssh、TTY 上 startx、systemd user service、
容器/WSL、**把服务装成开机自启服务**，都拿不到 PAM 建立的解锁连接；
(b) PAM 跑了但解锁失败——钱包密码 ≠ 登录密码时静默失败，首次访问弹密码框，
取消 → `unlock prompt was dismissed`；(c) `DBUS_SESSION_BUS_ADDRESS` **和**
`XDG_RUNTIME_DIR` 都没设 → 连不上会话总线。实测（2026-10-18）：只缺 `DBUS_SESSION_BUS_ADDRESS`
不影响——库会经 `XDG_RUNTIME_DIR` 自动发现总线；两个都缺才失败，
且因为 `secret-service` 是被**强制**的（见 `keyring.ts`），失败发生在
**构造期**并抛 `Platform failure: DBus error`，会让工厂退到 FingerprintBackend，
不是旧注释说的 "no result found"（那是读失败，属于另一档）。
**反复填写**不是这一档的症状：那是 fallback 也失败（`$DSH_HOME/credentials`
不可写）落到 MemoryBackend 才会发生；落到 FingerprintBackend 只需填一次。

真实机器排查命令：`ls ~/.local/share/keyrings/`；`default` 文件内容即别名
指向的集合名，指向的 `.keyring` 若是明文 ASCII（`keyring\n(name=...)`）即
损坏，libsecret 无法加载该集合，症状就是写入报 `no result found`。
修复：备份后把 `default` 别名文件改指有效集合（如 `default`），损坏文件
改名隔离（`.corrupt-<date>` 后缀），`pkill gnome-keyring-daemon` 让 D-Bus
重新激活以重载别名。注意重启后的 daemon 里集合是**锁定**态——无 PAM
自动解锁的 WSL/无头环境，弹框只在有 `DISPLAY` 的 daemon 下出现；
`gnome-keyring-daemon --daemonize --components=secrets --unlock` 从 stdin
读密码可无头解锁（密码正确时静默成功）。

---

## A-15. 测试绝不能碰真实环境

**这一节是血写的。** 同一类事故在本仓库发生过**两次**，两次都是我（Claude）造成的，
两次都破坏了真实凭据，而且**都是静默的**——测试全绿，只有用户后来调不通才发现。

### A-15.1 反面教材：`vi.mock` 拦不住 `createRequire`

`KeyringBackend` 这样加载原生绑定：

```ts
// packages/credentials-store/src/backends/keyring.ts:21
const require = createRequire(import.meta.url)
function loadKeyring(): KeyringModule {
  if (keyringModule === undefined) keyringModule = require('@napi-rs/keyring') as KeyringModule
  return keyringModule
}
```

`vi.mock('@napi-rs/keyring')` **对它完全无效**——mock 被静默忽略，真实模块照用。
于是测试里的 fixture 被写进了**开发者的真实 keyring**：

```ts
// 曾经的 packages/aishell-llm/tests/gateway.spec.ts —— 错误写法
vi.mock('@napi-rs/keyring', () => ({ Entry: MockEntry }))   // ← 无效！被忽略
const keyring = createCredentialsStore({ service: 'aishell-dsh' })
keyring.set('HW_ACCESS_KEY', 'test-ak')                      // ← 写进了真实 keyring
keyring.set('HW_SECRET_KEY', 'test-sk')
keyring.set('HW_SECURITY_TOKEN', 'test-sts-token')
```

**后果**（真实发生）：

- 真实 AK/SK 被覆盖成 `test-ak` / `test-sk`
- 凭空多出一个 `HW_SECURITY_TOKEN`（用户原本没有）
- 网关报 `403 {"code":"auth","message":"AK not in whitelist"}`——因为 `test-ak` 才 7 字符，
  真实 AK 是 20 位
- **UI 依然全绿**，因为状态端点只看"是否已配置 + 账号名"，不回读凭据本身

**为什么难查**：症状（网关 403）和病因（几小时前跑的单元测试）之间毫无关联。

### A-15.2 正确写法：用包自己的测试钩子

`credentials-store` 专门为此提供了接缝：

```ts
// packages/credentials-store/src/backends/keyring.ts:31
/** @internal Test hook: inject a mock keyring module (vi.mock cannot intercept createRequire). */
export function __setKeyringModule(mock: KeyringModule | undefined): void {
  keyringModule = mock
}
```

```ts
// ✅ packages/aishell-llm/tests/gateway.spec.ts —— 正确写法
import { createCredentialsStore, __setKeyringModule } from '@huaweidevtools/aishell-dsh-credentials-store'

class MockEntry {
  constructor(private readonly service: string, private readonly account: string) {}
  private key(): string { return `${this.service}:${this.account}` }
  setPassword(v: string): void { /* 记到内存 Map */ }
  getPassword(): string | null { /* 从内存 Map 读 */ }
  deletePassword(): void { /* 从内存 Map 删 */ }
}

// 必须在任何 KeyringBackend 被构造之前注入
__setKeyringModule({ Entry: MockEntry })
```

**注意 `__setKeyringModule` 是模块级状态**：一旦设置，同一进程内所有
`createCredentialsStore()` 都走这个 mock。测试文件之间由 vitest 的进程隔离兜底。

**另一条更干净的路**：不要去 mock 存储层，而是**注入 store**。
`aishell-credentials` 的 `createCredentialRoutes(deps)` 就是为这个设计的——
直接用 `MemoryBackend`，一行 mock 都不需要：

```ts
import { MemoryBackend } from '@huaweidevtools/aishell-dsh-credentials-store'
const routes = createCredentialRoutes({ store: new MemoryBackend(), verify, ... })
```

`MemoryBackend` 是**纯进程内 `Map`**（`backends/memory.ts`），不碰任何外部状态。
**凡是能依赖注入的，就不要 mock。**

### A-15.3 规律：什么时候 `vi.mock` 会静默失效

`vi.mock` 拦截的是 **ESM/CJS 的模块解析**。以下情况它拦不住：

| 情况 | 例子 |
|---|---|
| `createRequire(...)` 懒加载 | `KeyringBackend` 加载 `@napi-rs/keyring` |
| 原生插件 / `.node` 绑定 | napi-rs、node-gyp 产物 |
| `require()` 动态路径 | `require(someVar)` |
| 模块级 `const x = require(...)` | 在测试文件被求值**之前**就已固定 |

**判别方法**：看目标模块是不是通过 `require` 拿的。若是，`vi.mock` 基本无效。

### A-15.4 自动防护：`vitest.setup.ts`

**不要再依赖自觉。** 根目录的 `vitest.setup.ts` 已在每个测试进程启动时把真实环境封死
（`vitest.config.ts` 的 `setupFiles` 加载它）：

| 防护 | 做法 |
|---|---|
| **密封 OS keyring** | `__setKeyringModule` 装一个构造函数即抛错的桩。任何 keyring 访问都会失败，并给出修复指引 |
| **重定向 home 派生路径** | `DSH_HOME` 与 `HOME` 都指向 `mkdtempSync(tmpdir()/aishell-test-home-*)`，使 `FingerprintBackend` 落到一次性目录，而不是 `~/.dsh` |
| **功能自检** | 启动时用 `createCredentialsStore()` 探一次：若返回 `KeyringBackend`，说明密封失效，**直接抛错终止**，绝不带着假安全感继续跑 |

自检是**功能性**的而非检查标志位——这正是它的价值：密封若悄悄失效，测试会当场失败，
而不是恢复成"看起来通过、实际在写真实环境"。

**验证过的实际效果**：

```
createCredentialsStore()  →  FingerprintBackend   （keyring 被密封，自动回落）
DSH_HOME                  →  /tmp/aishell-test-home-7RcTIn
直接 new KeyringBackend() →  抛错："Refusing to touch the real OS keyring from a test …"
```

**逃生舱**：测试确实要碰真实存储时，显式开启（会打印醒目警告）：

```sh
AISHELL_TEST_ALLOW_REAL_MACHINE_STATE=1 npx vitest run
```

优先用桩；只在"被测对象就是真实存储"时才用它。

### A-15.5 仍然应该手动验证：哨兵法

自动防护挡住了已知路径，但**新代码可能引入新的泄漏路径**（新的配置文件、新的外部服务）。
改动测试基础设施之后，仍建议用哨兵法确认：

```sh
# 1. 放哨兵进真实 keyring
printf '%s' 'SENTINEL' | secret-tool store --label='sentinel' \
  service aishell-dsh username HW_ACCESS_KEY

# 2. 跑测试
npx vitest run

# 3. 检查哨兵
secret-tool lookup service aishell-dsh username HW_ACCESS_KEY
#    SENTINEL → ✓ 没碰真实 keyring
#    别的值   → ✗ 有泄漏路径，必须修
```

**这一步不能省。** 我第一次"修复"时省略了它，结果没生效——直到又写坏一次才发现。

### A-15.6 写测试前先问三个问题

1. **这个测试会不会读/写机器上的真实状态？**（keyring、`~/.dsh`、环境变量、网络）
2. **我用的是 mock 还是依赖注入？** 优先依赖注入。
3. **如果我搞错了，会静默毁掉什么？** 若答案是"用户的凭据/配置"，改完必须用哨兵法验证。

### A-15.7 跨进程状态：测试写不到，但真机会

测试里的 `MemoryBackend` 是进程内的，真机是 D-Bus。两者行为**不同**，
所以下面这条也要记住（本次事故的另一半原因）：

- `secret-tool search` **会把 secret 明文打到终端**——查询时务必过滤
  ```sh
  secret-tool search --all service aishell-dsh 2>&1 | grep '^attribute.username'   # 只看条目名
  ```
- 诊断时若要把值取出来比对，**用比对而不是打印**：
  ```sh
  AK=$(secret-tool lookup service aishell-dsh username HW_ACCESS_KEY)
  [ "$AK" = "$EXPECTED" ] && echo "OK" || echo "MISMATCH"
  ```

---

## A-16. 速查表

### A-16.1 我要做 X，该用什么

| 需求 | 做法 |
|---|---|
| 加一个设置页 | `ctx.slots.register({name:'settings.section',...})` + `ctx.configForms.get(ns)` 读写 |
| 加一个状态/操作端点 | `ctx.connection.fetch.register`（§A-4.1） |
| 在输入框下方加东西 | `conversation.composer.dock`（**仅 session**） |
| 首页也显示 | `conversation.hero.*`（root scope）—— 但**全是 `single`**，见 §A-9.4.1 |
| 抢过官方/默认的同名槽位 | `priority: -1`（**越低越优先**，默认 0）—— §A-9.2.1 |
| 在同一行里换视觉位置 | 组件自己的 `order`（**不要** `marginLeft:'auto'`）—— §A-9.2.2 |
| 加双语文本 | `ctx.locale.register` + `LocaleNamespaceMap` 合并 |
| 存密钥 | 自己的 keyring + fetch 路由（**不要**走 settings） |
| 读宿主配置变化 | `ctx.on('loader/volatile-update', ...)` —— **只读，别回写** |
| 配置变化后要改配置 | 挂 `settings/document-updated`（事务后） |
| 给组件传业务对象 | `inject: () => ({ hooks: {...}, ... })` |
| 加宿主依赖 | `export const inject = ['serviceName']` |
| 加客户端包依赖 | package.json `dsh.client.inject`（**包名**） |
| 打开设置面板 | 点 `[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]`（无公开 API） |
| 可点击元素 | 用真 `<button>`，别用 `<span role="button">`——原生自带键盘与焦点语义 |
| **测试里要 keyring** | `__setKeyringModule({ Entry: MockEntry })`（**不是** `vi.mock`）—— §A-15 |
| **测试里要凭据存储** | 直接注入 `new MemoryBackend()` —— §A-15.2 |

### A-16.2 错误信息 → 原因

| 错误 | 原因 | 解法 |
|---|---|---|
| `HMR transactions cannot be nested` | 在 `loader/volatile-update` 里回写 settings | 换通道；或挂 `settings/document-updated` |
| `exact Fetch route "..." is already registered` | 同一 path 注册了两次 | 合并 methods 到一条注册 |
| `single slot "..." already has a registration` | 同 priority 已有 `single` 占位 | 换一个 priority（**负值才抢得过**）—— §A-9.2.1 |
| `Config field "..." is not volatile` | 写非 volatile 字段 | schema 加 `.volatile()` |
| `No configurable plugin entry "..."` | ns 不对 | ns = Loader 行的 id |
| `Configuration for "..." is overridden by a home patch` | 被更高优先级层覆盖 | 改 profile patch，别改别的层 |
| `Property 'x' does not exist on type 'Context'` | 缺 type-only import | §A-11 的表 |
| `1 entry did not activate` | `ctx.effect` 内抛错 | 看紧随其后的堆栈 |
| 网关 `403 AK not in whitelist` | **凭据被测试写坏了**，或凭据本身错 | 查 keyring 实际值 —— §A-15.1 |
| 组件不渲染、且**无任何报错** | 多半是 `priority` 正值或 bundle 未刷新 | §A-13.6 的四步 |
| `client bundles not found; run pnpm run build` + `lib/client.js` 不存在 | 浏览器半边有 class 私有字段，oxc panic；**CJS 崩、ESM 成功** | §A-13.8 |
| 构建耗时异常（>30s，正常约 1s） | 同上，Rust panic 后进程不退出，表现为卡住 | 立刻停掉，§A-13.8 |

### A-16.3 别做的事

- ❌ 在 `loader/volatile-update` 里 `settings.mutate`
- ❌ 同一路径注册两条 fetch 路由
- ❌ 用绝对路径 `/api/...` 调 fetch 路由（用 `api/...`）
- ❌ 试图给第三方插件注册 Typert Remote
- ❌ 把密钥写进 settings 文档
- ❌ 用 `console.log` 代替 `ctx.logger`
- ❌ 在 `ctx.effect` 外做注册（会泄漏）
- ❌ 靠未认证的 401 判断路由是否存在
- ❌ 把会话 token / keyring secret 打进工具输出
- ❌ **用 `vi.mock` 去 mock `createRequire` 加载的模块**（静默失效，会写坏真实环境）—— §A-15
- ❌ **改完测试不验证就认为没事**（必须用哨兵法）—— §A-15.5
- ❌ **给 `single` 槽写正的 `priority`**（输给默认 0，且无报错）—— §A-9.2.1
- ❌ **用 `marginLeft:'auto'` 调兄弟元素位置**（会顶到容器最边缘）—— §A-9.2.2
- ❌ **从结构相似推断行为**（`single` 与 `list` 的 priority 语义相反）—— §A-13.7
- ❌ **改了行为不改注释**（本次 hero chip 注释说"无 logo"，代码已有 logo）
- ❌ **在 `src/client/` 里用 class 私有字段**（oxc panic → `lib/client.js` 不产出）—— §A-13.8
- ❌ **只看构建退出码/`Build complete`**（ESM 成功不代表 CJS 成功）—— §A-13.8

---

## 附：本仓库相关文件

| 路径 | 说明 |
|---|---|
| `packages/aishell-credentials/src/index.ts` | 宿主半：fetch 路由 + IAM 校验 + keyring 写入 |
| `packages/aishell-credentials/src/client/index.ts` | 客户端半：槽位注册 + 路由调用 |
| `packages/aishell-credentials/src/client/AishellAccountHint.tsx` | composer 行上的账号 + 模式 chip（会话存在时才渲染） |
| `packages/aishell-credentials/src/client/AishellHeroChip.tsx` | 空白会话 hero 行上的同款 chip（`hero.workspace`） |
| `packages/aishell-credentials/src/client/permission-mode.ts` | 模式读取/切换的共享 hook（两个 chip 共用） |
| `packages/aishell-credentials/src/client/huawei-mark.ts` | 共享：logo 路径、品牌红、`CHIP_CLASS` 与 hover 样式注入 |
| `packages/aishell-credentials/src/client/open-settings.ts` | 共享：打开设置面板（点 sidebar 触发器） |
| `packages/aishell-credentials/src/client/locales.ts` | 字典 + `LocaleNamespaceMap` 合并 |
| `packages/aishell-credentials/tests/routes.spec.ts` | 路由行为契约测试（含安全断言） |
| `packages/credentials-store/src/signer.ts` | SDK-HMAC-SHA256 签名 |
| `packages/aishell-base/aggregate.yml` | 聚合清单；`cordis.patch.yml` 由它生成 |
| `vitest.setup.ts` | 测试环境密封：封死真实 keyring + 重定向 home 路径 —— §A-15.4 |

### 本仓库约定

- 构建：`pnpm run build`（= `tsc -b` + 各包 `build:bundle` + `node scripts/aggregate.mjs`）
- 单包重建：`pnpm --filter <pkg> run build:bundle`
- 测试：`npx vitest run`（配置 `vitest.config.ts`，`include: packages/**/tests/*.spec.ts`）
- 类型：`npx tsc -b`
- Lint：`npx oxlint packages`
- `packages/aishell-base/cordis.patch.yml` 是**生成物**，改 `aggregate.yml` 后重新聚合

---

## 1. 这是什么

DeepSeek Harness(简称 **DSH**)是一个**全插件化的 AI agent 运行时**。产品里的每一部分——模型适配器、工具注册表、session 日志、agent loop 本身——都是一个可从配置替换的 Cordis 插件。

**关键特征**:

- **没有特权核心**。扩展方式不是改框架代码,而是在其他插件旁挂一个新插件。
- **事件溯源**。所有对话状态是一个 append-only 的 session event log,模型看到的消息历史是 log 的纯函数投影。
- **Capability seam**。每个能力(文件系统、shell、子进程、沙箱)是一个有三角色的可替换接口:Service Definition / Provider / Consumer。
- **可组合**。一个运行中的 DSH 实例是一棵插件树,由 profile + bundle 的 patch 层在启动时组合而成,支持热重载。

**规模**:~335,000 行 TypeScript,~50 个包,pnpm workspace 管理。所有 npm 包命名为 `@deepseek-ai/dsh-<name>`。

**应用形态**:

| 命令 | 说明 |
|---|---|
| `dsh web` | 浏览器应用(`--profile web`) |
| `dsh --profile headless` | 一次性命令行运行 |
| `dsh --profile sdk` | SDK JSON-RPC 服务器(stdio) |
| `dsh --profile sdk-minimal` | 精简独立 SDK |
| `dsh --profile acp` | Agent Client Protocol 服务器(自动化) |

---

## 2. 核心概念

读这份文档前,先建立这 5 个概念。它们贯穿全仓。

### 2.1 插件即 Service

一个插件是一个实现 `Service` 的对象(或带 `apply(ctx)` 的函数)。它通过 `ctx.plugin()` 或 Cordis Loader 挂进 context 的生命周期,声明一个稳定的 `ctx.<key>`(如 `ctx.tools`、`ctx.llm`、`ctx.sessions`)。其他插件按键查找,不 import 具体实现。

声明方式是 TypeScript 的 declaration merging:

```typescript
// packages/core/tools/src/index.ts:129
declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime
  }
}
```

### 2.2 inject 声明依赖

插件用 `static inject = ['subprocess', 'sandbox']` 声明所需 service。Cordis 等这些 service 存在后才激活插件——加载顺序用 service 依赖表达,不靠手动 boot 序列。

```typescript
// packages/shell/bash-sandbox/src/index.ts:46
export class SandboxBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']
}
```

### 2.3 Typed Events

事件有 5 种 dispatch mode,语义不同:

| Mode | Await? | 顺序 | 返回值 | 用途 |
|---|---|---|---|---|
| `emit` | 否 | 注册序 | 无 | 观察 |
| `waterfall` | 否 | 注册序 | 有 | around-middleware,调 `next()` 委托 |
| `parallel` | 是 | 并行 | 无 | fan-out |
| `serial` | 是 | 注册序 | 有 | 顺序处理 |
| `bail` | 否 | 注册序直到一个 bail | 有 | 首个决定者 |

waterfall 是最常用的拦截点:listener 收到 `(...args, next)`,调 `next()` 把(可能改写的)结果传给下游,不调就短路。

### 2.4 注册是 reversible effect

所有贡献(prompt section、tool schema、adapter、listener)通过 `ctx.effect()` 或 `ctx.on()` 注册,返回 disposer。插件卸载/reload 时按注册逆序回滚。

### 2.5 Capability Seam

一个**可替换能力**有三个角色,缺一不可:

- **Service Definition**:声明接口的 Cordis `Service`(抽象类,占 `ctx.<key>`)。
- **Service Provider**:实现该接口的插件。
- **Consumer**:使用该服务的插件,通常是模型可见的工具。

> **为什么是抽象类而不是 TypeScript `interface`?** 因为抽象类能 `extends Service` 占 `ctx.<key>`,Cordis 的 duplicate-service 检测会在第二个 `ctx.shell` 注册时直接 throw。interface 没有这个运行时锚点。

---

## 3. 仓库布局

```
deepseek-harness/
├── packages/          @deepseek-ai/dsh-<pkg> 工作区包,按 group/pkg 组织
│   ├── core/            产品 API 脊柱:session, system-prompt, tools, agent, agent-loop, scope
│   ├── llm/             LLM 能力:Service Definition + DeepSeek providers
│   ├── shell/           bash 能力:Definition + local/sandbox providers + tool Consumer
│   ├── subprocess/      子进程能力 + local provider + Win32 库
│   ├── sandbox/         沙箱能力 + local provider + policy
│   ├── fs/              文件系统能力 + local/sandbox providers + tools
│   ├── session/         持久化 session 数据:persistence, projection, titles, telemetry
│   ├── subagent/        subagent 能力 + spawn/fork providers + tool Consumer
│   ├── workflow/        workflow 能力 + worker-thread provider + tool
│   ├── boot/            app-boot: profile/application 启动胶水
│   ├── bundle/          可安装的 dsh --profile patch 层 bundle
│   ├── sdk/             JSON-RPC 协议 + TS client/server
│   ├── typert/          类型图生成器/loader/runtime registry
│   ├── api/             Remote BFF assembly + Typert RPC gateway
│   ├── client/          web/desktop 客户端 UI(~97k 行)
│   ├── host/            host 侧服务(webserver, connection 等)
│   └── ...              (attachment, compaction, context, credentials, e2b, guard, hooks,
│                         identity, interaction, jobs, lsp, mcp, plan, preset, skill, spill,
│                         terminal, todo, web, webhook, workspace 等)
├── apps/              产品组装
│   ├── cli/             `dsh` CLI 入口
│   ├── web/             Vite 浏览器应用
│   ├── desktop/         Electron 桌面应用
│   └── desktop-host/    Electron host 进程加载器
├── vendor/            Cordis 框架及基础库的 vendored 源码(pinned,可审计,可 patch)
├── native/            @deepseek-ai/node-addon-system 原生 addon(Landlock 等)
├── python/            Python SDK + runtime wheel
├── docs/              架构文档、cookbook、postmortem、glossary
├── benchmarks/        性能门禁
├── scripts/           门禁和生成器脚本
└── .agents/           agent 工作流 + Agent Notes(设计决策记录)
```

### 各包按代码量排序(TOP 15)

| 包 | src 行数 | 职责 |
|---|---|---|
| client | 97,881 | web/desktop 客户端 UI |
| experimental | 36,368 | 预稳定原型(agent-team, inspector 等) |
| extensions | 18,928 | 工具扩展 |
| api | 16,179 | Remote BFF + Typert gateway |
| session | 15,851 | session 持久化/投影/遥测 |
| core | 14,178 | agent-loop/agent/session/tools/scope |
| llm | 13,395 | LLM Service Definition + DeepSeek adapter |
| subagent | 11,041 | subagent 能力 |
| typert | 9,077 | 类型图系统 |
| fs | 5,907 | 文件系统能力 |
| subprocess | 5,736 | 子进程能力 |

---

## 4. Cordis 插件框架

Cordis 是 DSH 之下的插件框架,vendor 在 `vendor/cordis/`(从 cordiverse/cordis fork,重 scope 到 `@deepseek-ai/`)。DSH 完全拥有这层框架——可审计、可 patch、pinned。

### 4.1 Context

Context 是 service 仓库。每个 service 在 context 上声明一个稳定 key。Context 可以 `extend()` 传递给子插件,子插件看到父的所有 service。

```typescript
// 创建 scoped context(给 agent 用)
const fiber = ctx.plugin(scope)                    // 空 fiber
const scopedCtx = fiber.ctx.extend({ [kScope]: key })  // 打 scope tag
```

### 4.2 Fiber 生命周期

每个插件挂在一个 **fiber** 上。fiber 有状态:`PENDING`(等依赖)→ `LOADING` → `ACTIVE` / `FAILED`。`fiber.dispose()` 卸载插件及其所有 effect。DSH 对 Cordis fiber 做了生命周期加固(见 `vendor/README.md` 第 6 条):effect 的 owner-list wrapper 在 setup body 运行前注册,async cleanup 保持 owner-visible 直到 quiescence,`UNLOADING` 状态拒绝新 effect 注册。

### 4.3 Loader

`@deepseek-ai/cordis-plugin-loader`(vendor 在 `vendor/loader/`)负责从配置文件构建插件树。它读一个 entry list(`cordis.yml`),每个 entry 指定 `name`(插件包名)和 `config`,按 service-availability 驱动激活(不是 row order)。

### 4.4 Include

`@deepseek-ai/cordis-plugin-include`(vendor 在 `vendor/include/`)提供 patch 机制:

- **`insert`**:插入新 entry row。
- **id-targeted patch**:按 `id` 替换某 row 的整个 `config`(不是 merge,是整体替换)。
- **`!!js` 表达式**:`config` 和 `disabled` 字段里的 `!!js` 在 entry 激活时求值,可引用 `process.env`、`dshHomePath()` 等。

```yaml
# cordis.patch.yml 示例
- insert:
    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform === 'win32'   # 平台条件
      config:
        timeoutMs: 60000
- id: approval                                       # 按 id 替换已有 row 的 config
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
```

> **关键本地修改**(vendor/README.md 第 11 条):`applyEntryPatches` 在 insert 时就索引每个 entry,所以同一 patch list 里后面的 patch 能配置前面 insert 的 row。上游只建一次 id index,inserted row 不可 patch——这在 DSH 的多层 patch 组合里是必需的。

### 4.5 HMR

`@deepseek-ai/cordis-plugin-hmr`(vendor 在 `vendor/hmr/`)提供热重载。live profile(`patchReload: 'live'`)在 `cordis.patch.yml` 编辑后事务性重新应用 patch 层,不重启进程。DSH 加固了它的 exact-config-watching 和序列化(见 vendor/README.md 第 9、12 条)。

---

## 5. Profile 与 Bundle 组合系统

一个运行中的 DSH 是一棵插件树,在启动时从有序 patch 层组合而成。

### 5.1 概念

- **Profile**:命名组合,存在 Harness home(`$DSH_HOME/profiles/<name>/`)。列出它堆叠的 bundle,持有 out-of-tree 插件,保留用户的 `cordis.patch.yml`。`web`、`headless`、`sdk`、`sdk-minimal`、`acp` 是内置模板。
- **Bundle**:Cordis config row 的分发格式(`cordis.patch.yml`)。每个 bundle 在 `package.json` 的 `dsh.bundle` 字段指向其 patch 文件。
- **`dsh-base`**(`packages/bundle/base/cordis.patch.yml`):`web`/`headless`/`sdk`/`acp` 共享的第一层,~90 行 insert 了所有核心插件。

### 5.2 层叠顺序

patch 层按以下顺序应用到空 entry list `[]` 上(后写者胜):

```
1. bundle layers(profile 的 dsh.profile.bundles 顺序)
2. profile 的 cordis.patch.yml
3. home-level cordis.patch.yml($DSH_HOME/cordis.patch.yml,跨所有 profile)
4. --patch 命令行 overlays
5. telemetry 开关
```

每一层都是 `PatchOptions[]`,通过 Include 的 `applyEntryPatches` 一次性 flatten 应用。

### 5.3 boot() 实现

`packages/boot/app-boot/src/index.ts:787` 的 `boot()` 函数:

```typescript
export async function boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  ctx.provide('dshHomePath', dshHomePath)           // 给 !!js 表达式用
  await ctx.plugin(Loader)                            // 装 Cordis Loader service
  await prepare?.(ctx)                                // host setup(provide cmdline/env/ready)
  await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
    // 装 Include + Group 为 loader builtins
    // ctx.loader.create({ id:'include', name:'cordis:include',
    //                     config:{ path: configPath, patches } })
    // Include 读 cordis.yml(空 []),applyEntryPatches 一次性应用全部 patch 层
  await ctx.get('loader')?.await()                    // 等整棵树 settle
  await assertEntriesActivated(ctx, binName)          // 审计:每个 enabled entry 必须 ACTIVE
  return ctx
}
```

`assertEntriesActivated` 会:
- **PENDING** entry → 报 "waiting for services: X, Y"(inject 声明的 service 还没就绪)
- **FAILED** entry → await fiber 恢复 private rejection reason,rethrow 带 original stack

### 5.4 dump-config

```sh
dsh --profile web --dump-config
```

打印组合后的完整插件树(带每行来源注释),不实际 boot。实现用 `renderConfigDump()`(`app-boot/src/index.ts:409`),它用和 `boot()` 完全相同的 `applyEntryPatches` 调用,所以 dump 就是 boot 会 mount 的东西。

### 5.5 自定义 profile

```sh
# 从内置模板创建自定义 profile
dsh --from-default-profile web myprofile

# 编辑 myprofile 的 cordis.patch.yml
# $DSH_HOME/profiles/myprofile/cordis.patch.yml
```

自定义 profile 默认 live patch reload——编辑 `cordis.patch.yml` 即时生效,不重启。

---

## 6. Agent Loop:运行时心脏

`packages/core/agent-loop/src/agent.ts` 的 `ReactLoopAgent` 类是默认 agent 驱动器。

### 6.1 三层循环

```
kick()                           [agent.ts:225]
  while (await this.turn()) {}   ← 反复跑 turn 直到返回 false
    turn()                       [agent.ts:269]
      append('turn/start')
      while (true):
        preStep()                [agent.ts:240]   ← agent/pre-step waterfall
        append('step/start')
        step()                   [agent.ts:352]   ← 一个 model request + 工具
        append('step/end')
        if turnEnds && inbox.nextStep empty:
          dispatch.serial('agent/turn-stopping')  ← 只观察,无 next()
        if turnEnds && inbox.nextStep empty: break
      append('turn/end', { reason: TurnEndReason })
```

**Turn** = 一次 admitted input 的排空,以模型和工具停止或终端策略干预结束。
**Step** = 一个 model request + 它触发的工具执行。一个 turn 含零或多个 step。

### 6.2 step() 内部

```typescript
// agent.ts:352
async step(decision) {
  const { assembly } = decision
  while (true) {                              // 重试循环
    const { config, preparedCall } = await this.prepareRequest(turn, step, signal)
    // ↑ agent/request waterfall,ctx.llm.prepareCall() 绑定 adapter generation

    // 系统提示 + 用户消息 commit 到 log
    systemPrompt.project() → append('system/message')
    append('user/message')

    // 构建冻结请求(从 log 投影 model history)
    const request = this.buildRequest(config, preparedCall, assembly.tools, ...)
    // ↑ append('request/header' / 'request/context')
    //   session.deriveMessages() → deepFreeze(messages)

    // 流式
    const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
    live.start()
    for await (const chunk of stream) { live.push(chunk) }

    // settle
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      live.settle('assistant/attempt', append)    // 不加 model history
      agent/request-error waterfall → 可 retry
      if retry: continue
    } else {
      live.settle('assistant/message', append)    // 加 model history,embed compact stream
      if finish.kind === 'max-tokens': return { kind: 'max-tokens' }
      if no tool calls: return { kind: 'completed' }
      executeToolCalls(...)                        // 跑工具
      return concluded ? { kind: 'completed' } : null
    }
  }
}
```

### 6.3 事件拦截点

| 事件 | Mode | 作用 | 代码位置 |
|---|---|---|---|
| `agent/pre-step` | waterfall | rewrite/reject claimed messages;reject 关闭 turn 不产生 step | agent.ts:249 |
| `agent/request` | waterfall | 改写 seedConfig(provider/model/reasoningEffort) | agent.ts:530 |
| `llm/stream` | waterfall | 包裹 adapter stream,可注入 chunk 或短路 | llm/index.ts:1114 |
| `agent/request-error` | waterfall | 决定 retry/abort | agent.ts:448 |
| `agent/turn-stopping` | serial | 观察停止决策,无 `next()` | agent.ts:316 |
| `agent/assistant-stream` | emit | live 流帧(start/chunk/end) | agent.ts:386 |
| `agent/status` | emit | idle/running 状态转换 | agent.ts:124 |

### 6.4 Inbox 与输入路由

Agent 有两个有序消息列表:

- **`next-turn`**:下一个 turn 才处理的消息。
- **`next-step`**:当前 turn 的下一个 step 处理的消息(如工具结果 context)。

```typescript
send(message, target, wakeup)    // 底层 API
followup(input)                  // = send(input, 'next-turn', true)   人类追问
steer(input)                     // = send(input, 'next-step', true)   实时引导
inject(input)                    // = send(input, 'next-step', false)  注入上下文(不唤醒)
```

`agent.inject()` 是加 model-facing context 的正式方式——它 land 在下一个 admitted request 里。

### 6.5 Phase 状态机

```typescript
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort; lastTurn; wakeRequested }   // 后台维护
  | { kind: 'running'; abort; turn; step; wakeRequested }     // 驱动中
```

`cancel()` 清 inbox + abort。`wakeDriver()` 在 idle 时开新 turn,在 running/maintenance 时 latch wake(等收敛后 replay)。后台进程(teardown、compaction)走 `runMaintenance()`。

### 6.6 AssistantStreamAttempt

`packages/core/agent-loop/src/assistant-stream.ts`。一个 model attempt 的 process-local 框架,三路输出:

```
chunk 进来
  → accumulator.push(timed)    → durable compact stream(给 assistant/message 的 stream 字段)
  → assembler.push(chunk)      → BlockAssembler 组装 ContentBlock[](给 message.content)
  → emit({type:'chunk'})       → live agent/assistant-stream frame(给 Web UI)
```

生命周期:`start()` → `push(chunk)` * N → `settle('assistant/message'|'assistant/attempt', append)`(在 durable event commit 后发 end frame)或 `abandon()`。

中断时 `interruptedBlocks()` 取已交付的 text/reasoning prefix,组装成 `interrupted: true` 的 `assistant/message`(有可见内容)或 `assistant/attempt`(无可见内容)。

---

## 7. Session 日志:事件溯源

`packages/core/session/src/index.ts` 的 `Session` 类。

### 7.1 append-only log

```typescript
class Session {
  private log: SessionEvent[]              // seq = log.length(连续性契约)
  private readonly surfaceManager = new SurfaceManager(this.log)

  append<T>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T> {
    // 1. snapshotJsonValue 验证 data 是 lossless JSON(拒绝 BigInt/symbol/undefined/circular/...)
    // 2. surfaceManager.validateNext 校验 surface 语义
    // 3. push + 通知 session/event listener(fire-and-forget,observer 失败不阻塞)
  }
}
```

### 7.2 SessionEventMap

完整的事件词汇表(merge-extensible,插件可扩展),`packages/core/session/src/types.ts:269`:

| 事件类型 | 数据 | 说明 |
|---|---|---|
| `turn/start` | `{ turn }` | 开 turn |
| `turn/end` | `{ turn, reason: TurnEndReason }` | 关 turn,带结束原因 |
| `step/start` | `{ turn, step }` | 开 step |
| `step/end` | `{ turn, step }` | 关 step |
| `user/message` | `UserMessage` | 用户消息(人类 prompt / inject context / goal continuation) |
| `system/message` | `{ turn, step, message: SystemMessage }` | 渲染后的系统提示 |
| `assistant/message` | `{ turn, step, message, stream, usage?, interrupted? }` | 成功的 assistant 消息,embed compact timed stream |
| `assistant/attempt` | `{ turn, step, stream }` | 失败/重试/取消的 attempt,不加 model history |
| `tool/call` | `{ turn, step, callId, name, arguments }` | 模型请求工具 |
| `tool/result` | `{ turn, step, message, error?, meta? }` | 工具结果 |
| `request/header` | `{ header: EpochHeader, reason, startsSeries? }` | 请求快照(config + tools) |
| `request/context` | `RequestContext` | 路由元数据 |
| `session/end-seed` | `{ inherited? }` | fork 种子边界 |

**关键属性**:

- `ignorable: true` 标记允许旧 reader 跳过未知事件。默认 required(忘了标记会 over-refuse,不是静默错误)。
- `SESSION_FORMAT_VERSION = 3`,只有结构性变更(header shape、envelope、core event 语义、surface 机制)才 bump。加普通 event type 不 bump。
- `SurfaceOp`:`'append'` 或 `{ op: 'replace', startSeq, endSeq }`(compaction 用)。只有 4 个 surface event type(`system/message`、`user/message`、`assistant/message`、`tool/result`)能带 SurfaceOp。

### 7.3 Surface 与 deriveMessages()

**Surface** 是 message-producing event 的有序 seq 视图。`deriveMessages()` 走 surface 的 seq,逐节点 project 成 `Message[]`:

```typescript
// session/index.ts:832
deriveMessages(): Message[] {
  const nodes = surface.nodes                    // 有序 surface seq
  for (const seq of nodes.slice(this.derivedNodes)) {
    const msg = this.deriveEventMessage(this.log[seq])
    if (msg) this.derived.push(msg)              // 空 assistant/message → null,不进 transcript
  }
  this.derivedNodes = nodes.length
  return [...this.derived]                        // 每次返回新数组,内容是共享冻结对象
}
```

**缓存**:每个 surface node 只 project 一次。surface rewrite(compaction `replace`)时重建缓存。

> **"model-visible ⟺ logged"**:模型看到的消息历史是 session log 的纯函数。`buildRequest()` 里 `deepFreeze` 每个 message。有 runtime invariant 断言:任何到达 model request 的东西必须能从 log 重建。这就是为什么"新的 model-visible 输入需要新的 session event"。

### 7.4 增量 fold

Session 维护两个增量 fold(每事件只 fold 一次):

- `requestHeader()`:最新 `EpochHeader`(config + adapterDefaults + tools),O(new events)。
- `requestContext()`:最新 `RequestContext`(provider/model/contextWindow/systemPromptUpdate)。

### 7.5 持久化

`packages/session/session-persistence/src/index.ts` 的 `SessionPersistence` 抽象 service:

```typescript
interface SessionPersistence {
  create(meta, options): Promise<SessionHandle>   // 创建
  open(id, options): Promise<SessionHandle>        // 打开(读或写)
  stat(id): Promise<SessionPersistenceSnapshot>    // 轻量观察(不读全 log)
  list(): Promise<SessionPersistenceSnapshot[]>    // 列表
  export(id): Promise<SessionInspection>           // 完整导出
}
```

**JSONL provider**(`packages/session/session-persistence-jsonl/`):

- v0 = `session.jsonl[.zstd]`,v1+ = `session.vN.jsonl[.zstd]`
- committed generation 路径**永不重命名/替换/删除**。
- 相邻迁移包(`session-format-v0-to-v1` 等)各管一步 `vN → vN+1`。
- read open 选最高 canonical generation,refuse future version,或 compose 静态迁移链。
- write open 先 encode/verify/exclusive publish 最终 version-named successor。

### 7.6 Fork

```typescript
// session/index.ts:1203
fork(source, boundary?, childSessionId?): Session
```

从 live source 的稳定前缀创建 child。boundary 是 inclusive source event seq。选中的 slice 不能结束在 open turn 里(否则抛 `OPEN_TURN`)。child 的 header 带 `parentSession`、`isSeeded: true`、`inheritedEventCount`。

### 7.7 SessionStore 生命周期事务

`create()` 内部是 `prepare() → enter() → announce()` 三步,折叠进一个 `ctx.effect`:

- `prepare()`:构造 Session,不进 store。
- `enter()`:装 publication hooks + 加进 store,返回 detach disposer。
- `announce()`:emit `session/created`(synchronous throw 可 veto + 回滚)。

分离是为了让 agent factory 能把 session 生命周期折叠进自己的 composite effect,保证 fiber unload 时 session + agent 按序 teardown(loop 的最终 event 在 store detach 前提交)。

---

## 8. LLM 能力层

`packages/llm/llm/src/index.ts` 的 `LlmRuntime` + `LlmAdapter` 抽象类。

### 8.1 LlmRuntime

```typescript
class LlmRuntime extends TypertRemoteService {
  // adapter 注册表
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
  // 可配置 provider 目录(用户 settings 激活)
  registerConfigurableProviders(entries): DirectoryRegistrationHandle
  // model 发现( interrogation provider endpoint)
  registerModelDiscovery(settingsNs, discover): () => void

  // 核心 API
  prepareCall(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>   // 绑定 adapter generation
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>            // 流式(经 llm/stream waterfall)
}
```

`registerAdapter` 返回的 handle 带 `replace(providers)`——原子路由替换,无 gap(一个同步 section 完成,无 observer 看到中间态)。

### 8.2 LlmAdapter 抽象类

```typescript
abstract class LlmAdapter {
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>  // 唯一必须实现的方法
  providerInfo(provider): LlmProviderInfo
  providerRetryPolicy(provider): ResolvedRetryPolicy | undefined
  resolveModel(provider, model, signal?): Promise<LlmResolvedModelInfo>
  prepareCall(provider, model, signal?): Promise<PreparedAdapterCall>     // 动态 adapter 可 override
  listModels(provider): Promise<readonly LlmModelInfo[]>
  imageRequestPricing(provider, model): LlmImageRequestPricing | undefined
}
```

### 8.3 PreparedLlmCall:一次性绑定

```typescript
interface PreparedLlmCall {
  readonly config: LlmCallConfig                    // 冻结,带 adapter-owned default
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: LlmModelContext                // contextWindow 等
  readonly systemPromptUpdate?: SystemPromptUpdate  // 'in-history' 等
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>  // 一次性!
}
```

> **为什么是一次性?** 防 HMR 在 prepare 和 dispatch 之间换 adapter,把一个 generation 的 capability 结果和另一个 generation 的 endpoint 组合。`stream()` 有 `dispatched` flag + `callConfigEquals` 校验:`stream()` 第二次调用或 config 变了就抛 `INVALID_PREPARED_CALL`。

### 8.4 流式管线

```
ctx.llm.stream(options)
  → streamWithRegistration()  [llm/index.ts:1110]
    → ctx.waterfall('llm/stream', options, () => this.adapterStream(options, prepared))
      ↑ listener 可注入 chunk 或短路
      → adapterStream()  [llm/index.ts:1011]
        选 adapter → resolveModel → 校验 config
        projectFilesToText()        // 文件永远投影成 handle text,不 native dispatch
        projectImagesForTextModel() // 图片按 model modality 投影
        dispatch(forAdapter(options, adapter))  // 移除其他 adapter 的 replayState
        逐 chunk yield
        adapter throw → terminal finish chunk(error/aborted)
```

### 8.5 DeepSeek adapter

`packages/llm/llm-deepseek/src/adapter.ts`:纯 `fetch` + SSE,打 OpenAI-compatible chat-completions endpoint。

**连接事实**通过 thunk 每次操作 resolve(`options: () => DeepSeekConnectionOptions`),bearer token per-request resolve(`resolveApiKey: (connection) => Promise<string>`)。配置变更下次请求即生效,无需重注册。

**`translate.ts`** 逐 delta 维护 per-index 的 text/reasoning/tool-call block:
- finish + usage 都 defer 到 `[DONE]` sentinel。
- `mapUsage()` 专门处理 DeepSeek 的 `prompt_tokens` **含** cache hit 的语义(减去 cacheRead 让 harness 用 disjoint 计数:`inputTokens = prompt_tokens - cacheRead`)。
- `stop` → `{kind:'stop'}`,`tool_calls` → `{kind:'tool-calls'}`,`length` → `{kind:'max-tokens'}`,其他(content_filter 等)→ `{kind:'error'}`。
- 空 `stop` finish 且无 block → `EMPTY_RESPONSE` error(不是成功空消息)。

### 8.6 LlmError 分类码

`LlmError extends HarnessError`,带稳定 code:`AUTH`、`RATE_LIMIT`、`NO_ADAPTER`、`INVALID_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED`、`QUOTA_EXCEEDED`、`EMPTY_RESPONSE`、`UNSUPPORTED_REASONING_EFFORT` 等。failure 对象含 `status`、`providerRetryAfterMs`、`requestId`。

---

## 9. 工具执行管线

`packages/core/tools/src/index.ts` 的 `ToolRuntime` + `packages/core/agent-loop/src/tool-calls.ts` 的调度器。

### 9.1 管线阶段

```
tools/pre-execute  (waterfall, gate: allow/deny/ask)
  ↓
monotonic guard    (返回 reason 即 deny,无法 force-allow)
  ↓
tools/execute      (waterfall, around-dispatch, wrapper 可换 signal 但不能移除)
  ↓
tool body          (tool.execute(args, exec))
  ↓
createSuccessResult (validate output.schema, render content, project presentationMeta)
  ↓
tools/post-execute (waterfall: accept/replace/block)
  ↓
finalizeContent    (tool 自有的同步 content 变换)
  ↓
tools/result       (emit, 观察最终冻结结果)
```

### 9.2 ToolDefinition

```typescript
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition    // 必须声明:{ schema, render, presentationMeta? }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>   // 返回 canonical JSON value
  finalizeContent?(exec, result): ContentBlock[] | undefined       // 同步 last-mile 变换
  timeoutMs?: number
  isConcurrencySafe?(args): boolean      // true 才进 parallel pool
  presentCall?(args): ToolCallView | undefined    // UI 呈现(pending)
  presentResult?(args, result): ToolResultView | undefined  // UI 呈现(completed)
}
```

> **关键**:tool body 返回的是 canonical lossless-JSON value,不是 ContentBlock。`output.render(args, value)` 把 value 投影成 model-facing content。这样 output schema 验证和 content 渲染分离。

### 9.3 并发调度

`executeToolCalls()` ([tool-calls.ts:60](../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts#L60)):

- 按 `executionMode()` 分类:`parallel`(isConcurrencySafe=true)进 bounded rolling pool,`exclusive` 形成 barrier。
- pool 大小上限 `ctx.agentLoop.config.maxParallelToolCalls`。
- **结果按 model order 提交**:`commitReady()` 只在连续 slot 就绪时推进。
- **abort 处理**:已启动的 call drain 并提交,未启动的补 synthetic error result(保证 replay 有效)。
- scheduler failure:drain dispatches,不 fabricate recovery results。

### 9.4 PTC 模式(run_code)

`mode: 'ptc'` 时模型只看到 `run_code` 一个工具 + 生成的 SDK prompt。其他工具从 `run_code` 程序内调用。

```typescript
// tools/index.ts:1314
private collapses(name, scope, nested): boolean {
  return !nested && this.modeFor(scope) === 'ptc' && name !== RUN_CODE_NAME
}
```

- **model-direct call**(`nested=false`):非 `run_code` 名字被拒绝,返回 `UNKNOWN_TOOL` 带 "call from inside run_code" 提示。
- **nested sub-dispatch**(`parent` token set):可调任何可见工具。
- `mode: 'both'`:同时发 native schema + run_code。

### 9.5 审批集成

`ask` 决策经 `serviceAsk()` ([tools/index.ts:1679](../deepseek-harness/packages/core/tools/src/index.ts#L1679)) 路由到 `ctx.approval`:

```
allowed-once → allow
rejected     → deny("the user rejected tool X")
cancelled    → deny("approval for X was cancelled"), approvalCancelled=true
unavailable  → deny("no approval channel available")
```

无 approval service 时 degrade 到 deny(fail-closed)。

### 9.6 取消与 signal 融合

`fuseToolSignals(caller, wrapper)` ([tools/index.ts:1879](../deepseek-harness/packages/core/tools/src/index.ts#L1879)):caller signal 和 around-wrapper 替换的 signal 融合成一个 `AbortController`,任一 abort 都触发。dispatch-scoped,work settle 后 remove listener。

- body 未启动时 abort → `ABORTED_BEFORE_DISPATCH`
- body 已启动时 abort → `ABORTED`(但仍 drain 到 quiescence)

---

## 10. Capability Seam:三角色模式

这是 DSH 最核心的架构模式。一个 seam = Service Definition + Provider + Consumer,缺一不可。

### 10.1 完整示例:shell

| 角色 | 包 | 类/文件 | ctx key |
|---|---|---|---|
| **Definition** | `dsh-shell` | `ShellExecutor extends Service` ([shell/src/index.ts:64](../deepseek-harness/packages/shell/shell/src/index.ts#L64)) | `ctx.shell` |
| **Provider (local)** | `dsh-bash-local` | `LocalBashExecutor extends ShellExecutor` | 注册为 `ctx.shell` |
| **Provider (sandbox)** | `dsh-bash-sandbox` | `SandboxBashExecutor extends LocalBashExecutor` | 注册为 `ctx.shell`(替换 local) |
| **Consumer** | `dsh-tool-bash` | `defineTool()` + `inject=['tools','shell',...]` | 模型可见的 `bash` 工具 |

### 10.2 request→spec split

> **模板规则**:defaulting 是 owning implementation 的显式 `resolve(request): Spec` 步骤,绝不是 `run()` 里的隐藏 `?? default`。

```typescript
// shell/src/index.ts:84
abstract class ShellExecutor extends Service {
  abstract resolve(request: ShellExecRequest): ShellExecSpec   // 显式 defaulting 步骤
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>   // 只接受已 resolve 的 spec
  abstract start(spec: ShellExecSpec): ShellProcess            // 后台
}
```

`SandboxBashExecutor.resolve()` stamp per-call sandbox policy:

```typescript
// bash-sandbox/src/index.ts:85
override resolve(request: ShellExecRequest): ShellExecSpec {
  return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
}
```

### 10.3 one execution world

shell provider **不自己 spawn 进程**,而是 `inject=['subprocess']` 通过 `ctx.subprocess.spawn`:

```typescript
// bash-local/src/index.ts:103
export class LocalBashExecutor extends ShellExecutor {
  static inject = ['subprocess']
  // run() 内部调 ctx.subprocess.spawn(spec)
}
```

换 subprocess provider 到 E2B 远程沙箱,Bash/PTY/LSP 全跟着走,**零 provider fork**。后台进程生命周期绑 `ctx.subprocess` disposal——executor-only reload 不杀进程。

### 10.4 所有 seam 一览

| Seam | Definition | Providers | Consumer |
|---|---|---|---|
| **llm** | `LlmRuntime` | `dsh-llm-deepseek`, `dsh-llm-pi-ai` | agent-loop |
| **shell** | `ShellExecutor` | `dsh-bash-local`, `dsh-bash-sandbox`, `dsh-pwsh-*` | `dsh-tool-bash`, `dsh-tool-pwsh` |
| **subprocess** | `SubprocessRuntime` | `dsh-subprocess-local`, `dsh-subprocess-e2b` | shell providers |
| **sandbox** | `SandboxProvider` | `dsh-sandbox-local` | `dsh-bash-sandbox`, `dsh-fs-sandbox` |
| **fs** | `FileSystem` | `dsh-fs-local`, `dsh-fs-sandbox`, `dsh-fs-e2b` | `dsh-tool-fs`, `dsh-tool-fs-search` |
| **tools** | `ToolRuntime` | (各 tool 包 register) | agent-loop |
| **sessions** | `SessionStore` | (core) | agent-loop, projection |
| **subagents** | `SubagentRuntime` | `dsh-subagent-spawn-in-process`, `-fork`, `-acp`, `-claude-code`, `-codex` | `dsh-tool-subagent` |
| **web** | `WebRuntime` | `dsh-web-search-deepseek`, `dsh-web-fetch-http` | `dsh-tool-web` |
| **approval** | `ApprovalService` | `dsh-user-approval` | ToolRuntime (serviceAsk) |
| **sessionProjections** | `SessionProjectionRegistry` | (各 domain 包 register) | host readers, client carriers |

---

## 11. Scope:per-agent 注册

`packages/core/scope/src/`。一个 contribution(tool、prompt section、restriction、listener)是 global(所有 agent 可见)或 scoped(只对一个 agent 可见)。

### 11.1 机制

- **`ScopeKey = object`**:opaque,靠对象身份比较。一个 live agent 就是它自己 scope 的 key。
- **`createScope(ctx, key)`** ([scope/index.ts:137](../deepseek-harness/packages/core/scope/src/index.ts#L137)):`ctx.plugin(scope)` 造 fiber,`fiber.ctx.extend({ [kScope]: key })` 打 tag。通过这个 scoped ctx 的注册自动带 scope 身份。
- **`scopeParents` WeakMap**:存父子关系。`bindScopeParent(key, parent)` 建 link,有 cycle 检测。

### 11.2 两个方向

| 方向 | 机制 | 效果 |
|---|---|---|
| **注册可见性** | `ScopedLayers.chainLayers(scope)` 沿父链向上返回所有祖先 layer | child 看到祖先的注册(继承) |
| **事件路由** | `scopeTarget(base, key)` 的 filter:tagged listener 只在 tag 是 dispatch key **或其祖先**时通过 | 父 scope 的 listener 收到所有后代的事件(观察) |

> **关键设计**:注册可见性是 child 向上查祖先层,事件路由是 listener 向上匹配祖先。两个方向不对称但自洽。**scoped 注册不向下继承到 subagent**——subtree 行为用 lineage 数据(`parentSession`、`delegationDepth`)表达,不用 scope 层级。

### 11.3 shadowing

`ScopedLayers.merge()`:global layer + 沿链祖先层,最近 scope 的同名 entry 赢。

```typescript
// tools/index.ts:1142 — ToolRuntime.view()
private view(scope?: ScopeKey): ToolView {
  const layers = this.layers.chainLayers(scope)     // 祖先链
  const inherited = new Map(this.layers.global.tools.entries())
  for (const layer of layers) {
    if (layer === own) continue
    for (const [name, def] of layer.tools.entries()) inherited.set(name, def)  // 覆盖
  }
  // 自己的注册最后加,shadowing inherited
  if (own !== undefined) for (const [name, def] of own.tools.entries()) visible.set(name, def)
}
```

### 11.4 restriction

`tools.restrict({ allow, deny })` ([tools/index.ts:1061](../deepseek-harness/packages/core/tools/src/index.ts#L1061)):per-scope 过滤 **global** tool set(intersection)。只过滤继承的,不过滤自己 layer 注册的。restricted-away tool 在 prompt 和执行中都 absent,和 nonexistent 的无法区分。

---

## 12. 审批与权限

### 12.1 ApprovalService

`packages/interaction/user-approval/src/index.ts`。`ctx.approval`:

```typescript
class ApprovalService extends Service {
  // policy: 'ask'(默认,委托 answerers,无 answerer 时 fail-closed) | 'never'(自动 reject)
  async request(req: ApprovalRequest): Promise<ApprovalOutcome>
  // outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
}
```

- 审计对(`approval/asked` + `approval/decided`)必须 turn-enclosed(bare event 在 turn 间是 crash-tail garbage)。
- `never` policy 在 dispatch 前决定,不受 listener 注册顺序影响。
- `setPolicy()` 切换策略 + `agent.inject()` 通知模型。

### 12.2 Permission presets

`dsh-permission-presets` 提供 sandbox + approval 的预设组合:

| 模式 | sandbox | approval |
|---|---|---|
| `read-only` | read-only | ask |
| `workspace-write`(默认) | workspace-write | ask |
| `danger-full-access` | danger-full-access | never |

环境变量 `DSH_PERMISSION_MODE` 覆盖。

### 12.3 Sandbox 升级

`dsh-tool-bash` 实现了 sandbox 升级流程:命令被 deny 后,可在同一 turn 用 `sandbox_permissions`(最窄的更宽模式)+ `justification` 重试一次。`approveEscalation()` 路由到 approval service。rejected 后该命令最终,不能 workaround。

---

## 13. 沙箱与执行世界

### 13.1 SandboxProvider

`packages/sandbox/sandbox/src/index.ts:158`:

```typescript
abstract class SandboxProvider extends Service {
  abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
}
```

- **不 spawn**:只返回包装后的 argv + enforcement 事实。
- **policy per-call**:不固定在 provider 上。两个 consumer 可同时不同 policy。
- **fail-closed**:要么返回 enforcing argv,要么抛 `SandboxUnavailableError`。

### 13.2 本地后端 argv 包装

`packages/sandbox/sandbox-local/src/profiles.ts`:

| 平台 | runner | profile 构造 |
|---|---|---|
| **Linux (bwrap)** | `bwrap` | `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent` + workspace-write 时 `--tmpfs /tmp --bind root root` |
| **Linux (Landlock)** | 原生 addon `landlock-run` | `landlockGrantArgs({ readOnly: ['/'], readWrite: ['/dev/null','/tmp',root] })` |
| **macOS (Seatbelt)** | `sandbox-exec -p` | SBPL: `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))` + writable roots `(subpath "...")` |
| **Windows (ACL)** | restricted-token runner | per-workspace write SID(跨 session 复用)+ per-session 随机 private temp dir + SID(dispose 撤销) |

provider 选 chain(Linux: bwrap 优先 → Landlock fallback;macOS: Seatbelt;Windows: ACL),每个 rung functional probe 一次(`spawnSync` 跑 `true`),缓存结果。

### 13.3 denial vs runner failure

`ConfinedArgv` 带 `denialSignatures`(该后端的拒绝方言:EROFS for bwrap、EACCES for Landlock、EPERM for Seatbelt)和 `runnerFailureRules`(runner 自己挂了的 stderr 签名)。consumer 先检查 runner failure(命令没跑),再检查 denial(confinement 工作了但拒绝了写)。

### 13.4 E2B 远程沙箱

`packages/e2b/`。E2B 是 "one execution world" 的终极证明:

- `E2BRuntime extends Service` 占 `ctx.e2b`,共享一个 E2B SDK `Sandbox` handle。
- `E2BSubprocessRuntime extends SubprocessRuntime` 注册为 `ctx.subprocess`。
- `dsh-fs-e2b` 注册为 `ctx.fs`。

换 E2B 作为 subprocess + fs provider,**整个执行世界全移到远程 Linux sandbox**,零 provider fork。E2B SDK 的 `/bin/bash -l -c` 层用 `quoteE2BShellArg` 转义,`HOME` 随机化隔离 login shell。

---

## 14. Subagent 与 Workflow

### 14.1 Subagent 能力

`packages/subagent/subagent/src/index.ts`:`ctx.subagents`,named-provider 注册表。

```typescript
interface SubagentProvider {
  readonly capabilities: SubagentCapabilities   // agentOptions, outputSchema, depthLimit, toolFilter, persona
  readonly inheritsParentContext: boolean
  start(request: ResolvedSubagentStartRequest): SubagentRun          // one-shot
  prepareContinuable(): Promise<ContinuableCreateSpec>               // continuable
}
```

### 14.2 Provider 对比

| Provider | 继承父上下文 | model 选择 | 用途 |
|---|---|---|---|
| **spawn-in-process** | 否(`inheritsParentContext = false`) | 可选 | 全新 child agent,最廉价 |
| **fork-in-process** | 是(继承 event prefix seed) | 不选(保持相同,复用 KV cache) | fork child |
| **subagent-claude-code** | — | — | 委托到 Claude Code 产品 |
| **subagent-codex** | — | — | 委托到 Codex 产品 |
| **subagent-acp** | — | — | ACP 跨进程 |
| **subagent-dsh-sdk** | — | — | DSH SDK 跨进程 |

### 14.3 spawn 的 child 组成

spawn 的 child 在 **setup window**(创建后、session 发布前)应用:

- `agentOptions`:合并到父 route(provider/model/reasoningEffort)。
- `outputSchema`:scoped structured runtime(child 只输出符合 schema 的结构化结果)。
- `depthLimit`:递归深度上限(durable `delegationDepth`)。
- `toolFilter`:`agent.ctx.tools.restrict()` 限制 child 可用工具。
- `persona`:scoped shadowing persona section。

### 14.4 continuable children

不走 `SubagentRun`。`SubagentContinuationManager` 持有 `AgentHandle`,通过 child 自己的 inbox 排序 turn。`sendMessage` 在相邻 Agent 间 steer。

### 14.5 Ralph loop

`dsh-tool-ralph`:fresh-agent workflow,不可变 objective。每 round 是一个全新 child session(无父/前 child 对话 seed),共享 workspace + bounded Ralph handoff(结构化报告:status/summary/evidence/next steps/blocker)。`maxRounds` 上限(默认 64)。

### 14.6 Workflow

`dsh-workflow-worker-thread`:workflow 脚本在 worker thread 里跑,可 fan-out 多个 subagent。`dsh-tool-workflow` 是模型可见的工具。

---

## 15. Compaction:上下文压缩

`packages/compaction/compaction-basic/src/index.ts` 的 `BasicCompactionEngine`。

### 15.1 触发

`inject = ['llm', 'tokenMeter', 'sessions']`。用 `ctx.tokenMeter` 测 token 压力,超过 `thresholdRatio × contextWindow` 触发自动 compaction。

### 15.2 机制

- `summarize()` 是唯一子类化 hook,默认 `summarizeWithLlm` 调独立 summarization provider/model。
- compact 操作通过 `compactSurfaceRegion` 做 surface **`replace`**:替换一段 surface nodes 为单个 summary node,保留 cited source events(seq 记在 `sourceEventSeqs`)。
- **per-model policy override**:按 provider/model 给不同 threshold/retain。
- **overflow retry**:compact 后仍超窗口,重试有限次(`maxOverflowRetries`)。

### 15.3 手动 compaction

`/compact` 命令(`dsh-command-compact`):做一次低于自动阈值的压缩。

### 15.4 Tool result pruner

`dsh-compaction-tool-result-pruner`:在 conversation compactor 跑之前,先压缩超大的单个 tool result(`thresholdChars: 8192`,`headChars: 4096`,`tailChars: 1024`)。

---

## 16. Session Projection:增量状态折叠

`packages/session/session-projection/src/index.ts` 的 `SessionProjectionRegistry`(`ctx.sessionProjections`)。

### 16.1 设计

每个 domain 注册一个 **pure synchronous fold**:

```typescript
interface ProjectionDefinition<K, S> {
  key: K
  stateSchema: ZodType<S>
  init(header, inheritedEventCount): S                    // 空 log 初始状态
  apply(state: S, event: SessionEvent): S                 // 纯 transition(不变返回同引用)
  wire?: { viewSchema, view(state) }                      // client view(omit = host-only)
  stateVersion: number                                    // 持久化 cache invalidation
}
```

### 16.2 eager drive

registry 订阅 `session/event` 一次。每个 committed event eager drive 过**所有**注册 unit 的 `apply`。用 `Object.is` 引用比较判断变化(无变化零开销)。watermark 缓存 per-session per-unit cell。

### 16.3 读取

| 方法 | 用途 |
|---|---|
| `stateOf(session, key)` | 读 host typed state |
| `snapshot(session, keys?)` | 读 cropped client view(带 viewSchema 校验) |
| `cachedSnapshot(session, keys?)` | 只读已 materialized 的 cell(可能 trail live) |
| `checkpoint(session)` | 持久化 cache 写侧:`{key → {ver, seq, val}}` |

### 16.4 冷读 restore

`restore(checkpoint, events, baseSeq, header, inheritedEventCount)`:从持久化 checkpoint + tail 重放。`stateVersion` 不匹配的 row 丢弃;row 声称的 seq 超过 log end 的拒绝(检测 crash-repair truncation)。

---

## 17. SDK 协议

`packages/sdk/protocol/src/types.ts`。newline-delimited JSON-RPC over stdio。

### 17.1 请求面(3 个)

| Method | Params | Result | 说明 |
|---|---|---|---|
| `initialize` | `{ cwd, provider, model, reasoningEffort?, maxTokens? }` | `{ serverInfo: { name, version } }` | 进程级握手 |
| `session/prompt` | `{ sessionId, contentBlocks }` | `{ messageId }` | 一次用户 turn(未知 sessionId 懒创建) |
| `shutdown` | `undefined` | `{}` | 关闭 |

### 17.2 通知面(4 个)

| Notification | Payload | 说明 |
|---|---|---|
| `session.event` | `{ sessionId, event: SessionEvent }` | 流式 session-log event(全量) |
| `session.status` | `{ sessionId, status: 'idle'\|'running' }` | agent 状态转换 |
| `subagent.started` | `{ parentSessionId, childSessionId }` | 子 session 创建 |
| `subagent.finished` | `{ provider, agentId, parentSessionId, childSessionId, status, stopReason, lastAssistantMessage? }` | 子 agent 结束 |

### 17.3 TypeScript SDK

`packages/sdk/client/` + `packages/sdk/server/`。server 是 `dsh-sdk-app` bundle 挂载的 `HarnessSdkJsonRpcServer` 插件。

---

## 18. Typert:跨进程类型投影

`packages/typert/`。类型级 Host↔Wire 对象 lookup 系统,把同进程 Cordis service 方法跨 framed byte pipe 暴露。

### 18.1 机制

```typescript
// typert/protocol/src/types.ts
interface TypertLookup<Host, Wire> { ... }   // Host 对象 ↔ wire identity

// 业务包声明
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>
    agent: TypertLookup<Agent, SessionId>
  }
}
```

`@Remote` 装饰器在 `TypertRemoteService` 子类上生成 Remote 方法:

```typescript
class LlmRuntime extends TypertRemoteService {
  @Remote listProviders(): LlmProviderInfo[] { ... }
  @Remote('discoverModels') async remoteDiscoverModels(...): Promise<...> { ... }
}
```

### 18.2 RemoteResult

```typescript
type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RemoteFailure }
```

carrier 失败折叠进 error 分支,consumer 不需要 try/catch。只有 assembly fault(arity、unmounted method、missing Context adapter)才 reject。

### 18.3 组成

| 包 | 职责 |
|---|---|
| `typert/protocol` | 共享类型协议 |
| `typert/generator` | 类型图生成器(从 declaration 生成 Remote 客户端代码) |
| `typert/loader` | 运行时加载器 |
| `typert/registry` | runtime registry(client/host adapter) |
| `api` | Host Gateway(BFF + RPC gateway) |

---

## 19. Client UI 架构

`packages/client/`,~97k 行,web/desktop 共用。完整架构参考 `docs/subsystems/web-client.md`。

### 19.1 双半架构

每个 DSH 包可以同时拥有 **Host 半**(Node.js,消费 `ctx.*` 业务服务)和 **Client 半**(浏览器,`dsh.client.platform: "web"`),也可以只有其一:

- `llm-deepseek` 只有 Host 半(provider 实现)。
- `ui-settings-models` 只有 Client 半(React 组件 + Remote 消费)。
- `api/session-controller` 两半都有:Host 侧 `SessionController` 管权威状态,Client 侧 `ClientSessions` 维护 React-free mirror。

两半之间**只走 typert remote**,不存在直接 import。依赖方向链:

```
Host state → Remote transport → Client model → UI adapter → Slots → React
```

| Layer | Owner | 职责 |
|---|---|---|
| Host application | `packages/api/*-controller` Host entries | 权威状态、持久化、mutation ordering、access policy、stream 生产 |
| Transport | `client/connection`, `api/gateway`, `api/remotes` | 建立 Client generation,暴露 `ctx.remote` 方法与 streams |
| Client models | `api/*-controller/client` | React-free mirror,resolve stream/unary race,持有 object identity |
| UI adapters | `client/ui-session`, `client/ui-workspace` | 把 model observables 转成 root/session-scoped standard slot sources |
| Composition | `client/ui-slots`, `client/ui-renderer` | 声明扩展位置,派生 props,绑 observable → React hooks,挂载 root tree |

用户动作反向回流:component callback → inject face 或 slot owner → `ctx.sessions` / `ctx.workspaces` / generated Remote → Host Controller → authoritative update → stream/event 投影回 Client。**presentation component 永远不收 `ctx`、transport 对象、或另一 feature plugin 的实现。**

### 19.2 Slots 系统

Slots 是 Web Client 的 typed React 组合系统。`dsh-client-ui-slots` 定义 React-free registry + type algebra;`dsh-client-ui-renderer` 绑 observable 到 hooks、渲染 tree、内部持有 React contexts。Feature plugin 通过 `ctx.slots.register()` 贡献 UI,**不 import 另一 feature plugin 的 component**。

#### 注册 API

```typescript
ctx.slots.register(
  {
    name: 'settings.section',   // slot key(必须在 SlotMap 中声明)
    id: 'models',                // list/keyed cell 的地址
    order: 10,                   // 排序(低值先渲染)
    label: () => t('nav'),       // 可选,locale-following thunk
    locale: 'settings.models',   // 可选,声明 locale namespace → 注入 t()
    inject: injected,            // 可选,inject factory(见下)
    children: {                  // 可选,声明 child slots(只有 owner 能声明)
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
    },
  },
  Component,
)
```

`ctx.slots.inject(key, callback)` 解决激活顺序问题:callback 在每次 slot 声明 lifetime 时运行,owner collapse 时移除其 effects,owner 重新 mount 时再运行。**当一个 feature 注入另一 package 拥有的 slot 时必须用 `inject()`,因为两者激活顺序未约束。**

```typescript
ctx.slots.inject('settings.section', () =>
  ctx.slots.register({ name: 'settings.section', id: 'models', order: 10 }, ModelsSection))
```

#### cardinality 与 scope

| Axis | Value | 含义 |
|---|---|---|
| cardinality | `single` | 一个 cell,priority winner 渲染 |
| cardinality | `list` | 按 `id` 寻址,`order` 排序 |
| cardinality | `keyed` | owner dispatch `entryKey`,匹配 cell 渲染 |
| cardinality | `chain` | 每个 entry 提供 `select(owner)`,priority 序首个非 null 结果渲染 |
| scope | `root` | 一个 root-scoped component + store instance |
| scope | `session-maybe` | 跟随当前 selection,但无 Session 仍可渲染 |
| scope | `session` | 需要已 resolved 的 Session binding |

#### Props 四股

组件收到的 props 由 binding site 组装,组件**永远不收 `ctx`**:

| Input | 声明者 | 类型 |
|---|---|---|
| owner values + standard scope values | `SlotMap` row + scope adapters | `PropsRuntime<K>` |
| authorized child renderers | registration 的 `children` keys | `PropsRenderSlots<S>` |
| selector hook + mutation callbacks | registration 的 `store` | `PropsStore<H>` |
| private data, callbacks, observable hooks | registration 的 `inject` factory | `InjectFace<I>` |

`inject` factory 在 plugin 的 `apply` 世界运行,可 close over 注入的 Cordis services,只返回组件需要的数据和 callbacks。其返回值中的保留 `hooks` compartment 接受 bare `getSnapshot`/`subscribe` source:

```typescript
const injected = (): ModelsSectionInjected => ({
  controller,
  operations,
  schema,
  t,
  hooks: { snapshot: controller.store },  // renderer 绑成 useSnapshot() hook
})
```

renderer 把 `hooks: { snapshot }` 转成 `useSnapshot(selector)` component prop,按 source identity 缓存 binding。组件**不收 source 本身**,也不直接调 `useSyncExternalStore`。

slot owner 可在 child declaration 里放 `inject` face(给所有 occupant 统一能力),其中 `hooks` 里的 function-valued member 是 hook factory,收 slot standard props + 可选 per-render `hookContext`,返回 constrained hook。`conversation.chat.node` 用此机制提供 `useTurnData(key)`。

### 19.3 Slot 层级

`root` 是唯一 built-in declaration,`ui-renderer` 调 `ctx.slots.renderSlot('root', {})`;所有 descendant 通过 owner entry 的 `renderSlot` / `renderSlotChain` prop 渲染。完整 shipped tree(见 `docs/subsystems/slots.md`):

```text
root
├─ sidebar
│  ├─ sidebar.brand.mark
│  ├─ sidebar.brand.name
│  ├─ sidebar.panellist
│  ├─ sidebar.footer.action
│  ├─ sidebar.workspaces
│  │  └─ sidebar.workspaces.directoryFlow
│  └─ sidebar.settings
│     ├─ settings.trigger
│     ├─ settings.header
│     ├─ settings.action
│     ├─ settings.close
│     ├─ settings.onboarding
│     └─ settings.section          ← list + root,可注入自定义 Settings 分区
│        ├─ settings.general.item
│        ├─ settings.models.provider-card
│        ├─ settings.models.footer
│        └─ settings.plugins.tab
│           └─ settings.plugin.item
├─ main
│  └─ main.conversation
│     ├─ conversation.session
│     │  └─ conversation.view
│     │     ├─ conversation.chat.node
│     │     │  ├─ conversation.chat.assistant-actions
│     │     │  ├─ conversation.chat.commandview
│     │     │  ├─ conversation.chat.turnTail
│     │     │  └─ tool.call.toolview
│     │     │     ├─ tool.call.images
│     │     │     └─ tool.view.cordis
│     │     ├─ conversation.message.images
│     │     └─ conversation.trajectory.images
│     ├─ conversation.session.header
│     │  ├─ conversation.session.header.lineage
│     │  ├─ conversation.session.header.actions
│     │  ├─ conversation.session.header.utilities
│     │  └─ conversation.session.header.corner
│     ├─ conversation.composer
│     │  └─ conversation.approval.detail
│     ├─ conversation.composer.bar
│     │  ├─ conversation.input.attachments
│     │  ├─ conversation.input.plan
│     │  └─ conversation.input.model
│     ├─ conversation.input.overlay
│     ├─ conversation.input.dock
│     ├─ conversation.composer.dock
│     ├─ conversation.input.left
│     ├─ conversation.input.right
│     ├─ conversation.hero.brand.mark
│     ├─ conversation.hero.workspace
│     │  └─ conversation.hero.workspace.directoryFlow
│     └─ conversation.hero.agentPreset
├─ rightbar
│  └─ rightbar.session
│     ├─ sidebar.right.pane.tab
│     │  └─ sidebar.right.tab.guide
│     ├─ sidebar.right.pane.tab.title
│     └─ sidebar.right.tab.menu.item
└─ shell.overlay
```

`settings.section` 是 `list` + `root` scope,feature 包通过 `ctx.slots.inject('settings.section', ...)` 注入自定义 Settings 分区。运行时可用 `cordis_inspect what:"client"` 查询 live tree;source catalog 由 `pnpm run gen-client-catalog` 从 `SlotMap` 声明 + `slots.register()` 调用点生成。

### 19.4 Host↔Client 通信

#### @Remote 装饰器

Host 业务 service 继承 `TypertRemoteService`(extends `Service`),构造时注册 service key + namespace:

```typescript
// packages/api/settings-controller/src/credentials.ts
export class CredentialsController extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'credentialsController', { namespace: 'credentials' })
  }

  @Remote
  async describe(refs: string[]): Promise<Record<string, CredentialInfo>> { ... }

  @Remote
  async set(ref: string, value: string): Promise<void> { ... }

  @Remote
  async unset(ref: string): Promise<void> { ... }
}
```

`super(ctx, serviceKey, { namespace })` 注册到 Cordis + 绑定 Typert Gateway。`@Remote` 装饰器在 prototype 上记录 versioned descriptor,`@Remote('exportName')` 可指定 wire method 名,`@Remote({ mode: 'stream' })` 声明 logical stream。

#### typert codegen

`typertPlugin`(tsdown 插件)在构建时生成两份产物:

- `./typert`(host 侧):`lib/typert.host.js` + `.d.ts`——strict descriptors、runtime codecs、declaration merges。
- `./remote`(client 侧):`lib/typert.remote-client.js` + `.d.ts`——typed client namespace contribution。

Client 侧 `api-remotes` assembly 选 generated contribution,通过 `ctx.remote.$mount(contribution)` 挂载 namespace,暴露 `ctx.remote.<namespace>` + session-scoped `agentCtx.remote.<namespace>`。

#### SRC fallback

不跑 codegen 时,Host 侧 Gateway 通过运行时反射读 `remoteMethods(service)` 发现 `@Remote` 标记的方法并 dispatch。**但 client 侧没有 typed namespace**——`ctx.remote.<namespace>` 不存在,只能走无类型的 generic dispatch。生产构建必须跑 codegen。

#### 调用链示例

```
Client: ctx.remote.credentials.set(ref, value)
  → Connection (request correlation, /api carrier, trust check)
  → API Gateway (dispatch, cancellation)
  → Host: CredentialsController.set(ref, value)
  → this.ctx.get('credentials') → CredentialProvider.set(branded, value)
  → RemoteResult 回传
```

Feature 包依赖 generated service face(`@deepseek-ai/dsh-api-remotes/client` 的 `import type`),不依赖 Gateway 实现或 Host package 的 runtime entry。

### 19.5 Client 插件 package.json

```json
{
  "name": "@deepseek-ai/dsh-client-ui-settings-models",
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings"],
      "external": ["@deepseek-ai/dsh-client-ui-settings"]
    }
  },
  "exports": {
    "./client": "./lib/client.js"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*"
  }
}
```

| `dsh.client` 字段 | 含义 |
|---|---|
| `platform` | 固定 `"web"` |
| `inject` | 依赖包名数组(factory arrival + plugin composition edges) |
| `external` | 可选,额外 module-table 请求(超出 baseline 的 specifiers) |

#### bundle 格式

Client bundle 是 **CJS closure-factory**。`tsdown.client.ts` 的 `outputOptions`:

```javascript
banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
footer: 'return module.exports; } });',
intro: 'var module = { exports: {} }; var exports = module.exports;',
```

加载时 `window.__ModuleLoader__.load({ id, factory })` 注册 factory;materialize 时跑 factory,通过同步 `require` 解析 platform modules + 声明的 dynamic 依赖。

#### externals (PLATFORM_MODULES)

以下 specifier 是 module-table row,永远 external:

```typescript
// packages/client/web/src/platform.ts
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const
```

非 externals 的 `@deepseek-ai/*` 包要么 **inline-safe**(wire/type 层,无 shared runtime identity),要么被 **purity gate 拒绝**(build-time error)。`INLINE_SAFE` regex 匹配 `dsh-typert-protocol`、`dsh-session`、`dsh-llm`、`dsh-file-reference` 等;generated `/remote` contribution 也 inline。其他 `@deepseek-ai/*` value import 是 cross-plugin 泄漏——必须通过 cordis service 协作。

`peerDependencies` 只需 `@deepseek-ai/cordis`(其余 framework 依赖由 shell 提供)。Node 半的 `dependencies` / `peerDependencies` / `optionalDependencies` 在 Node build 里作为 production externals。

### 19.6 现有 settings.section 例子

#### ui-settings-general — GeneralSection

简单场景:只有 `locale` + `children`,无 inject factory:

```typescript
// packages/client/ui-settings-general/src/client/index.ts
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'general',
  order: 0,
  label: () => t('general.nav'),
  locale: 'settings',
  children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
}, GeneralSection))
```

该包同时注册 `sidebar.settings` owner(`SettingsRoot`),声明 `settings.section` 等 child slots。`inject: ['slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope']`。

#### ui-settings-models — ModelsSection

完整场景:inject factory + hooks + Remote 订阅:

```typescript
// packages/client/ui-settings-models/src/client/index.ts
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings',
  'settingsScope', 'settingsSchema',
]

export function apply(ctx: ClientContext): void {
  const schema = createSettingsSchemaOperations(ctx.settingsSchema)
  const operations = createModelsOperations(ctx)
  const controller = new ModelsSettingsStore(ctx, schema, ctx.settingsScope.describe())
  const t = ctx.locale.bind(NS) as ModelsSectionInjected['t']

  const injected = (): ModelsSectionInjected => ({
    controller,
    operations,
    schema,
    t,
    hooks: { snapshot: controller.store },  // → useSnapshot() prop
  })

  // Pushed invalidations:订阅 settings/credentials/llm 事件刷新 mirror
  ctx.effect(() => {
    const refreshModels = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refreshModels),
      ctx.remote.$on('credentials/reference-updated', refreshModels),
      ctx.remote.$on('llm/adapters-updated', refreshModels),
      ctx.on('connection/reset', refreshModels),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-models: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: injected,
    children: {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
    },
  }, ModelsSection))
}
```

两个包都遵循同一模式:`ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))`。`inject()` 确保 registration 在 `settings.section` slot 声明上 ledger 之后才执行,不依赖 `ui-settings` 与 `ui-settings-models` 的激活顺序。`ui-settings` 通过 `settingsScope` 注入先于 `ui-settings-models` 激活,但这是 store 依赖,不是 slot 声明依赖。

### 19.7 品牌 slot 例子

三个 `single` + `root` scope 的品牌 slot 可被替换以实现品牌换肤:

- `sidebar.brand.mark` — owner props `{ size: number }`,展开侧栏 + 收起轨道都渲染
- `sidebar.brand.name` — owner props `{ children?: never }`,展开时在 mark 旁边
- `conversation.hero.brand.mark` — owner props `{ size: number, className?: string }`,空会话首屏

官方 `ui-brand-official` 包就是模板(仅在 `DSH_CLIENT_BUILD_PROFILE === 'official'` 时注入):

```typescript
// packages/client/ui-brand-official/src/client/index.ts
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OfficialBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, OfficialBrandName)
    }))
}
```

社区插件(如 aishell-brand)去掉 build profile 门控,始终注入即可替换默认品牌。`single` slot 后注册者覆盖先注册者,非 official 构建无 `ui-brand-official`,品牌 slot 为空(shell 用 fish fallback),插件直接占据。

---

## 20. 聚合 profile 机制

DSH 的 `cordis.patch.yml` 支持一个 profile 聚合多个插件包。dsh-web 的 `scripts/aggregate.mjs` 是完整实现(shell 容错、client children 镜像、subpath exports);aishell-dsh-plugins 的简化版只做核心三件事。

### 20.1 aggregate.yml 清单

聚合包(如 `aishell-base`)手写 `aggregate.yml`:

```yaml
patchFrom:          # 子包目录,其 cordis.patch.yml insert 行被汇总
  - ../aishell-llm
  - ../aishell-credentials
  - ../aishell-brand
deps:               # 子包目录,写进 package.json dependencies 为 workspace:*
  - ../credentials-store
  - ../aishell-llm
  - ../aishell-credentials
  - ../aishell-brand
```

### 20.2 生成产物

`node scripts/aggregate.mjs` 生成两个文件:

- `cordis.patch.yml` — 汇总所有子包的 insert 行,row id 加 `aishell-` 前缀(命名空间化,避免与独立安装冲突)
- `package.json` — `dependencies` 字段填入 `workspace:*` 引用

```yaml
# AUTO-GENERATED — do not edit
# from ../aishell-llm
- insert:
    - id: aishell-llm
      name: '@huaweidevtools/aishell-dsh-llm'
# from ../aishell-credentials
- insert:
    - id: aishell-client-credentials
      name: '@huaweidevtools/aishell-dsh-client-credentials'
```

### 20.3 独立安装 vs bundle

每个功能包有自己的 `cordis.patch.yml`(单行 insert),可被 `dsh plugin add` 单独安装:

```sh
dsh plugin --profile <name> add link:<repo>/packages/aishell-llm
```

聚合包 `aishell-base` 一键全套:

```sh
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

聚合 bundle 的 row id 命名空间化(`aishell-*`),所以**聚合 bundle 和独立安装同一包可以共存**,不触发 loader 的 duplicate-entry-id 检查。

---

## 21. Desktop 应用

`apps/desktop/`(Electron)+ `apps/desktop-host/`。

### 21.1 架构

- Electron 在 signed application resources 里携带**精确的 dsh production runtime**。
- desktop-host 在 bundled Node.js 进程里加载 backend + client graph。
- renderer 通过 secure `dsh-app://` protocol 访问——**不开 web server、不开 loopback port**。
- Unary RPC / Remote streams / version-matched client assets 跨 versioned framed byte pipes。
- Node IPC 只用于生命周期控制。
- `$DSH_HOME/profiles/desktop` 存 external plugins + host-owned package links。

### 21.2 构建

`electron-builder` 打包,支持 mac arm64/x64、win x64。CI 通过 `.gitlab-ci.yml` 签名 + 上传。

---

## 22. Python SDK

`python/sdk/`。

### 22.1 HarnessClient

`python/sdk/src/deepseek_harness/client.py`:`subprocess.Popen` 启动 `dsh --profile sdk`,通过 stdio JSON-RPC 通信。

```python
@dataclass
class HarnessConfig:
    dsh_bin: str | None = None
    profile: str = "sdk"                    # 默认 profile
    patches: tuple[str, ...] = ()
    dsh_home: str | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    initialize_timeout_seconds: float = 30.0
    request_timeout_seconds: float | None = None
```

### 22.2 Runtime wheel

`python/sdk-runtime/`:打包正常 `dsh` CLI 为 `deepseek-harness-sdk-runtime-<platform>-<arch>`,client 默认启动 `dsh --profile sdk` + 显式 Harness home。minimal example 选 `sdk-minimal` profile。

---

## 23. 启动调用链全追踪

`dsh --profile web "task"` 的完整启动链:

```
apps/cli/src/bin.ts:runCli()
  → parseDshArgs(process.argv)
  → runProfile({
      environment: loadLayeredEnv('dsh'),     # .env: inherited > project > home,bootstrap 名校验
      profile: 'web',
      patchFiles: [],
      args: ['task'],
    })

apps/cli/src/profile-boot.ts:runProfile()  [profile-boot.ts:282]
  → installProxyFromEnvironment(env)          # Node fetch 不自动读 proxy env,必须先装
  → composeProfile('web', [])
    → prepareProfile('web')                    # loadProfile + 重写空 root cordis.yml
    → healProfilesModuleFallback(...)
    → loadOptionalPatches(homePatchPath)       # $DSH_HOME/cordis.patch.yml
    → loadOverlayPatches(--patch files)
    → profile.layers.flatMap(layer => layer.patches)   # bundle layers
    → composeEntries([bundlePatches, profile.patches, homePatches, overlays])
    → resolveTelemetryPatch(DSH_TELEMETRY_DISABLED, hasRow)
  → boot('dsh', rootConfig, allPatches(composed), prepare=(hostCtx) => {
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      provideCmdline(hostCtx, { args, exit, ready })
    })

packages/boot/app-boot/src/index.ts:boot()  [index.ts:787]
  → ctx = new Context()
  → ctx.baseUrl = configDir
  → ctx.provide('dshHomePath', dshHomePath)
  → await ctx.plugin(Loader)
  → prepare(ctx)                               # host setup(provide env/cmdline/ready)
  → mountRootInclude(ctx, configPath, patches)
    → ctx.loader.builtins.include = Include
    → ctx.loader.builtins.group = Group
    → ctx.loader.create({ id:'include', name:'cordis:include', config:{ path, patches } })
      → Include 读 cordis.yml(空 [])
      → applyEntryPatches(base, flattenedPatches)   # 一次性应用全部 patch 层
      → 每个 entry 按 name 解析插件包,ctx.plugin(插件)
      → service-availability 驱动激活(inject 声明的 service 就绪后才激活)
  → await ctx.get('loader')?.await()           # 等整棵树 settle
  → assertEntriesActivated(ctx, 'dsh')          # 每个 enabled entry 必须 ACTIVE
  → return ctx

# 回到 runProfile:
  → if patchReload === 'live':
    → watchUserPatches(ctx, { filename: profile.patchPath, compose: composeLive })
    → watchUserPatches(ctx, { filename: homePatchPath, compose: composeLive })
  → appReady.commit()
  → return { ctx, shutdown }

# 插件树激活后,各 bundle/profile 的 row 依次 mount:
#   dsh-base: timer, hmr, llm, session, typert, agent, tools, shell, sandbox, fs,
#             subagent, workflow, skill, web, approval, permission, ...
#   web-app: webserver, websocket, client graph, ...
# web profile 是 live: cordis.patch.yml 编辑即时生效
```

---

## 24. 一轮对话调用链全追踪

用户发 "task" prompt 到模型回复 + 工具执行的完整链:

```
SDK session/prompt 请求(JSON-RPC stdio)
  → HarnessSdkJsonRpcServer 收到 { sessionId, contentBlocks }
  → ctx.agents.get(sessionId) 或懒创建 agent+session
  → agent.send(userMessage, 'next-turn', wakeup=true)

ReactLoopAgent.send()  [agent.ts:128]
  → inbox.splice('next-turn', ..., [message])
  → wakeDriver()

wakeDriver()  [agent.ts:187]
  → setPhase({ kind:'running', turn:lastTurn, step:0 })
  → loopCtx.agents.withInitiator(this, () => this.kick())

kick()  [agent.ts:225]
  → while (await this.turn()) {}

turn()  [agent.ts:269]
  → session.append('turn/start', { turn })
  → while (true):
    → preStep(target, { turn, step })  [agent.ts:240]
      → inbox.claim(target, turn)                    # 取消息
      → ctx.systemPrompt.assemble(context)           # 组装 prompt sections + tool schemas
      → runtimeContext.project()
      → dispatch.waterfall('agent/pre-step', { messages, ...position, signal },
            () => ({ kind:'enter', messages: context ?? claimed }))
        ↑ listener 可 rewrite/reject;reject → turnEnds={kind:'blocked'},return false

    → session.append('step/start', { turn, step })
    → step(decision)  [agent.ts:352]
      → prepareRequest(turn, step, signal)  [agent.ts:501]
        → session.requestHeader()                    # 增量 fold
        → dispatch.waterfall('agent/request', { turn, step, signal },
              () => seedConfig)
          ↑ listener 可改 config
        → ctx.llm.prepareCall(proposedConfig, signal)
          → registration = adapters.get(provider)
          → adapter.prepareCall(provider, model, signal)
            → resolveModel → normalizeModelInfo → resolveCallWithInfo
          → return PreparedLlmCall { config, retryPolicy, adapterDefaults, stream, ... }

      → systemPrompt.project(renderedPrompt, { inHistory, startsSeries })
        → session.append('system/message', { turn, step, message }, intent)
      → session.append('user/message', message, { surfaceOp:'append' })

      → buildRequest(config, preparedCall, tools, startsRequestSeries, signal)  [agent.ts:553]
        → session.append('request/header', { header, reason })
        → session.append('request/context', requestContext)
        → boundaryMessages = session.deriveMessages()      # ← 从 surface 投影 model history
        → deepFreeze(boundaryMessages) + Object.freeze
        → return markAgentLoopRequest(Object.freeze({ ...header.config, messages, tools, sessionId, signal }))

      → live = new AssistantStreamAttempt(sessionId, ++counter, ..., turn, step, emit)
      → stream = preparedCall.stream(request) ?? ctx.llm.stream(request)
        → ctx.waterfall('llm/stream', options, () => adapterStream(options, prepared))
          → adapter.prepareCall / resolveModel
          → projectFilesToText / projectImagesForTextModel
          → DeepSeek adapter: fetch + SSE → translate() 逐 delta → StreamChunk
      → live.start()
      → for await (chunk of stream): live.push(chunk)
        → accumulator.push(timed)   → durable stream
        → assembler.push(chunk)     → ContentBlock[]
        → emit({type:'chunk'})      → agent/assistant-stream frame
      → live.finish()

      → if finish.kind === 'error' | 'aborted':
        → live.settle('assistant/attempt', () => session.append('assistant/attempt', { turn, step, stream }))
        → dispatch.waterfall('agent/request-error', { ...failure, retryPolicy, signal },
              () => undefined)
        → if action?.kind === 'retry': continue    # 重试,不重复 assembly/pre-step
        → else: throw LlmError

      → else (success):
        → message = createAssistantMessage({ content: live.blocks(), source: { provider, model } })
        → live.settle('assistant/message', () => session.append('assistant/message',
            { turn, step, message, usage, stream }, { surfaceOp:'append' }))
        → if finish.kind === 'max-tokens': return { kind:'max-tokens' }
        → toolCalls = message.content.filter(b => b.type === 'tool-call')
        → if toolCalls.length === 0: return { kind:'completed' }
        → executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext)

executeToolCalls()  [tool-calls.ts:60]
  → 按 executionMode() 分组(parallel pool / exclusive barrier)
  → 每个 call:
    → ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(exec)  [tools/index.ts:1449]
      → createExecution(exec)
        → snapshotJsonValue(exec.arguments) + deepFreeze
        → if collapses(name, scope, nested): return final-result(UNKNOWN_TOOL 带 route 提示)
      → if callerCancelled: return final-result(ABORTED_BEFORE_DISPATCH)
      → ctx.waterfall('tools/pre-execute', exec, () => ({ kind:'allow' }))
        ↑ gate: allow / deny(reason) / ask(reason)
      → if ask: serviceAsk(exec, gate)
        → ctx.approval.request({ agent, toolName, callId, reason, signal })
        → allowed-once → allow; 其余 → deny
      → guardReason(exec)                           # monotonic,无法 force-allow
      → if denialReason: return post-result(denial)
      → return { kind:'dispatch', exec }

    → ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(exec)  [tools/index.ts:1559]
      → ctx.waterfall('tools/execute', mutableExec, () => dispatchToolBody(exec))
        ↑ around-dispatch wrapper(可换 signal)
      → dispatchToolBody(exec):
        → fuseToolSignals(callerSignal, wrapperSignal)
        → tool = resolveExecution(name, scope, nested)
        → tool.execute(args, exec)                  # 真正跑工具
        → createSuccessResult(exec, tool, returned):
          → validate output.schema
          → tool.output.render(args, value) → content
          → tool.output.presentationMeta(args, value) → meta
      → normalizeDispatchResult(exec, result)
      → return { kind:'post-result', result }

    → ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(exec, result)  [tools/index.ts:1599]
      → ctx.waterfall('tools/post-execute', exec, result, () => ({ kind:'accept' }))
        ↑ accept(可选 replace content/value) / block(feedback → isError)
      → applyFinalContent(exec, result)             # tool 的 finalizeContent
      → materializeFinalResult(result)               # snapshot + deepFreeze
      → notifyResult(exec, result): ctx.emit('tools/result', exec, result)

    → appendToolResult(session, turn, step, block, result, callSeq)
      → session.append('tool/result', { turn, step, message, error?, meta? },
          { surfaceOp:'append', sourceEventSeqs:[callSeq] })

  → 结果按 model order 提交(commitReady)
  → return { concluded }  # result.concludesTurn === true 时 concluded

# 回到 step():
  → return concluded ? { kind:'completed' } : null

# 回到 turn():
  → session.append('step/end', { turn, step })
  → if turnEnds && inbox.nextStep.length === 0:
    → dispatch.serial('agent/turn-stopping', { turn, signal })
  → if turnEnds && inbox.nextStep.length === 0: break
  → target = 'next-step'   # 下一个 step 用 next-step target

  → session.append('turn/end', { turn, reason: turnEnds })
  → if inbox.hasPending: return true   # 还有 pending,继续下一个 turn
  → return false                        # 没了,kick() 退出
```

---

## 25. 定制开发手册

### 25.1 加一个模型可见的工具

**最简模板**:

```typescript
// my-tool/src/index.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from '@deepseek-ai/schemastery'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx) {
  return ctx.tools.register(defineTool({
    name: 'my_tool',
    description: '做某件事',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '输入' }
      },
      required: ['input'],
    },
    output: {
      schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
      render: (args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const { input } = args as { input: string }
      // exec.signal 是 AbortSignal,异步工作要观察它
      // exec.deferContext(userMessage) 可延迟 context 到 result 后
      // exec.concludeTurn() 可标记 turn 完成
      return { result: `处理了: ${input}` }
    },
  }))
}
```

**挂载**(在 profile 的 `cordis.patch.yml`):

```yaml
- insert:
    - id: my-tool
      name: './my-tool'   # 相对路径,或包名 @deepseek-ai/dsh-my-tool
```

**UI 呈现**(可选):

```typescript
presentCall(args) { return { type: 'card', card: { kind: 'generic', title: 'My Tool', ... } } }
presentResult(args, result) { return { type: 'card', card: { kind: 'generic', ... } } }
```

### 25.2 加一个 LLM provider

实现 `LlmAdapter` 抽象类:

```typescript
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

class MyAdapter extends LlmAdapter {
  async *stream(options) {
    // options.messages: Message[]（含 content blocks）
    // options.tools: ToolSchema[]
    // options.signal: AbortSignal
    // options.provider, options.model, options.maxTokens, options.reasoningEffort

    // yield StreamChunk:
    //   { type: 'block-start', index, kind: 'text'|'reasoning'|'tool-call' }
    //   { type: 'block-delta', index, delta: { type: 'text', text } }
    //   { type: 'block-end', index }
    //   { type: 'finish', reason: { kind: 'stop'|'tool-calls'|'max-tokens' } | { kind:'error', failure } | { kind:'aborted', failure } }
    //   { type: 'usage', usage: { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, reasoningTokens? } }

    // adapter throw → 自动变 finish chunk
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }
}

export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['my-provider'], new MyAdapter())
}
```

### 25.3 加一个新 capability seam

设计三角色(以 `my-cap` 为例):

```typescript
// my-cap/src/index.ts — Service Definition
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    myCap: MyCapability
  }
}

export abstract class MyCapability extends Service {
  constructor(ctx: Context) { super(ctx, 'myCap') }
  abstract doThing(input: string): Promise<string>
}

// my-cap-local/src/index.ts — Provider
export const inject = ['myCap']  // 不需要,Provider 注册 service,不消费它
export function apply(ctx) {
  // 注册为 ctx.myCap
  ctx.plugin(class extends MyCapability {
    async doThing(input) { return `done: ${input}` }
  })
}
// 注意:实际用 ctx.plugin() 或 schemastery Config class

// my-tool/src/index.ts — Consumer
export const inject = ['tools', 'myCap']
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'my_thing',
    ...
    async execute(args, exec) {
      return { result: await ctx.myCap.doThing(args.input) }
    },
  }))
}
```

### 25.4 加一个 capability 的 provider

不需要新建 seam,只换/加 provider。例如加一个远程 shell backend:

```typescript
import { ShellExecutor } from '@deepseek-ai/dsh-shell'

class RemoteShellExecutor extends ShellExecutor {
  static inject = ['myRemoteConn']   // 你的远程连接 service

  resolve(request) {
    // 显式 defaulting:request → spec
    return { command: request.command, timeoutMs: request.timeoutMs ?? 30000, ... }
  }

  async run(spec) {
    // 通过你的远程协议跑命令
    return { exitCode, stdout: { text, truncated: false }, stderr: { text, truncated: false } }
  }

  start(spec) {
    // 后台进程 handle
  }
}
```

在 profile patch 里替换 `bash-sandbox` row 的 `name` 指向你的包。

### 25.5 拦截请求/工具/turn

注册 event listener:

```typescript
export const inject = ['agentLoop']  // 或具体 service
export function apply(ctx) {
  // 拦截每个 step 前的输入
  ctx.on('agent/pre-step', (agent, payload, next) => {
    // payload: { messages, turn, step, signal }
    // 可 rewrite messages,或 reject(关闭 turn)
    // 必须调 next() 委托(除非短路)
    return next()
  })

  // 拦截 model request config
  ctx.on('agent/request', (agent, { turn, step, signal }, next) => {
    return next().then(config => ({ ...config, reasoningEffort: 'high' }))
  })

  // 观察工具结果(emit,不阻塞)
  ctx.on('tools/result', (exec, result) => {
    console.log(`tool ${exec.name} → isError=${result.isError}`)
  })

  // 停止 turn(serial,无 next)
  ctx.on('agent/turn-stopping', (agent, { turn, signal }) => {
    // 只观察,不能委托
  })
}
```

### 25.6 给某 agent 不同工具集

通过 agent preset 的 setup window:

```typescript
// 在 agent 创建的 setup 回调里
ctx.agents.create({
  sessionId,
  setup: (agent) => {
    // 通过 agent.ctx 注册 scoped 工具/restriction/persona
    agent.ctx.tools.restrict({ allow: ['bash', 'read', 'write'] })  // 只允许这三个
    agent.ctx.tools.register(myScopedTool)                           // 该 agent 专属
    agent.ctx.systemPrompt.section({ name: 'persona', text: '你是...', ... })
  },
})
```

### 25.7 加 durable session 状态

扩展 `SessionEventMap`:

```typescript
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'my-domain/state': {
      field1: string
      field2: number
    }
  }
}

// 追加事件
session.append('my-domain/state', { field1: 'x', field2: 42 })
// 注意:非 surface event 不带 SurfaceOp;surface event(system/user/assistant/tool)才需要

// 注册 projection 让 host/client 读
ctx.sessionProjections.register({
  key: 'my-domain',   // 需在 SessionProjectionStateMap 声明
  stateSchema: z.object({ field1: z.string(), field2: z.number() }),
  init: () => ({ field1: '', field2: 0 }),
  apply: (state, event) => event.type === 'my-domain/state' ? event.data : state,
  wire: { viewSchema: ..., view: (s) => s },
  stateVersion: 1,
})
```

### 25.8 自定义 profile

```sh
# 创建
dsh --from-default-profile web myprofile

# 编辑 $DSH_HOME/profiles/myprofile/cordis.patch.yml
```

```yaml
# 替换默认 model
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-reasoner

# 禁用某工具
- id: tool-web
  disabled: true

# 加自己的插件
- insert:
    - id: my-plugin
      name: './my-plugin'
      config:
        myOption: 42

# 条件挂载
- insert:
    - id: my-linux-only-plugin
      name: './my-plugin'
      disabled: !!js process.platform !== 'linux'
```

### 25.9 加 session 存储后端

实现 `SessionPersistence`:

```typescript
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

class MyPersistence extends SessionPersistence {
  async create(meta, options) { /* 存 header + seed events,返回 handle */ }
  async open(id, options) { /* 读或写打开,返回 handle */ }
  async stat(id) { /* 轻量观察(不读全 log) */ }
  async list() { /* 列表 */ }
  async export(id) { /* 完整导出 */ }
}
```

在 profile patch 里替换 `session-persistence-jsonl` row。

### 25.10 常用命令

```sh
pnpm install                 # 安装（node ^22.19 || >=24）
pnpm run test                # 单元测试
pnpm run test:coverage       # CI coverage gate（per-file 100% on packages/*/*/src）
pnpm run test:e2e            # real-API 测试（无 DEEPSEEK_API_KEY 自跳过）
pnpm run test:snapshot       # keyless recorded-session replay
pnpm run typecheck
pnpm run lint                # oxlint
pnpm run build               # tsc + tsdown
pnpm dsh --profile web       # 从源码跑 web
dsh --profile web --dump-config   # 打印组合树
```

---

## 26. 工程规范与约定

### 26.1 核心约束

| 约束 | 含义 |
|---|---|
| **model-visible ⟺ logged** | 任何到达 model request 的东西必须能从 session log 重建,有 invariant 断言 |
| **plugins, not loop changes** | 新行为挂在 extension point 上,改 `agent-loop` 要更新 architecture.md |
| **opaque ids 用 Branded** | `SessionId`、`SessionSeq`、`ToolCallId` 等,用 `Branded<B>`,不是 bare `string` |
| **registrations are effects** | 所有注册走 `ctx.effect()`/`ctx.on()`,返回 disposer |
| **waterfall listeners MUST call next()** | 不调就短路 |
| **switch on discriminant tags** | closed union 用 `assertNever`,merge-extensible 走 documented default |
| **explicit > implicit at boundaries** | defaulting 是显式 `resolve()` 步骤,不是隐藏 `?? default` |
| **misconfiguration fails loud** | load 时自包含的配置错误立即 throw,不静默跳过 |

### 26.2 边界校验

**trust TypeScript at typed same-process boundaries**:不为静态接口要求的值加 runtime validation/fallback/hostile-input 测试。只在这些边界校验:

- parser/config
- queued
- model/tool JSON
- durable/file
- worker
- process
- wire

### 26.3 文档

- 每个非平凡改动配 **Agent Note**(`.agents/notes/`),只有机械/局部编辑豁免。
- 每个 `.md` 有 `.zh.md` + `.i18n.yaml`。
- client UI copy 走 typed dictionary + `t()`。
- `verify-export-jsdoc` 强制每个 export 有 JSDoc。

### 26.4 测试

- `test:coverage`(不是 `test`)是 CI coverage gate,per-file 100%。
- 每个 non-trivial model/product-visible 改动更新 keyless recorded-session snapshot。
- capability seam 要覆盖 lifecycle 路径 + transcript 输出。
- fixture 在 macOS/Linux replay;fix fixtures,not normalizers。

### 26.5 TODO 语义

`FIXME`(紧急)/ `TODO`(待办)/ `XXX`(隐患),按 urgency。

### 26.6 文件规范

- ESM everywhere(`"type": "module"`)。
- 跨包用包名,本地相对 import 用 `.ts`。
- 文件末尾恰好一个 trailing newline。
- 每个 npm 包是 `@deepseek-ai/dsh-<name>`,vendored 包重 scope 到 `@deepseek-ai/` 且 `private: true`。

---

## 27. 术语表

| 术语 | 定义 |
|---|---|
| **Cordis** | DSH 之下的插件框架(vendored),插件贡献 service/event/effect 到共享 context |
| **profile** | 命名组合,列 bundle + 持 patch.yml + out-of-tree 插件 |
| **bundle** | Cordis config row 的分发格式(cordis.patch.yml) |
| **turn** | 一次 admitted input 的排空,以模型/工具停止或终端策略结束 |
| **step** | 一个 model request + 它触发的工具执行;turn 含零或多个 step |
| **round** | 外层策略迭代(如 goal round、Ralph round),不是每个 turn |
| **seam** | 可替换能力,三角色:Definition / Provider / Consumer |
| **scope** | per-agent 注册单元;global 或 scoped(一个 agent) |
| **scope key** | opaque 身份,对象身份比较;live agent 是自己 scope 的 key |
| **shadowing** | scoped tool/section 替换同名 global,只对该 scope |
| **restriction** | per-scope 过滤 global tool set(intersection) |
| **surface** | message-producing event 的有序 seq 视图,deriveMessages 的源 |
| **SurfaceOp** | `'append'` 或 `{op:'replace', startSeq, endSeq}`(compaction) |
| **SessionEventMap** | merge-extensible 的事件词汇表 |
| **SESSION_FORMAT_VERSION** | 当前 3,只有结构性变更才 bump |
| **PreparedLlmCall** | 一次性 model generation 绑定(防 HMR 跨 generation) |
| **PTC mode** | `run_code` 折叠:模型只看 run_code,其他工具从程序内调 |
| **Ralph loop** | fresh-agent workflow,不可变 objective,每 round 全新 child |
| **projection** | pure fold over session events,watermark 缓存,增量 drive |
| **Typert** | 类型级 Host↔Wire lookup,`@Remote` 生成跨进程方法 |
| **RemoteResult** | `{ok:true, value} \| {ok:false, error}`,carrier 失败折叠进 error |
| **Agent Note** | 设计决策记录,每个非平凡改动必须配 |
| **dsh-base** | web/headless/sdk/acp 共享的第一层 bundle |
| **one execution world** | shell/subprocess/fs 共享执行世界,换 provider 全跟着走 |
| **request→spec split** | 显式 `resolve(request): Spec` 步骤,`run()` 只接 spec |
| **fail-closed** | 无 approval/无 sandbox 时拒绝,不静默 passthrough |

---

> **结语**:这份文档覆盖了 DSH 从启动到对话、从架构到定制、从概念到代码行的全部内容。遇到具体问题,用目录定位章节,用 `文件:行号` 引用去 DSH 源码确认细节。定制开发时,先想"这是哪个 seam 的哪个角色"或"这是哪个 extension point",然后照第 24 章的模板动手。

---

**版本与维护**:

- 本文基于 DSH `0.1.6-alpha.2` 撰写。DSH 升级后,API 可能 break——以 DSH 仓库的 `.agents/notes/`、`CHANGELOG` 和 `pnpm run typecheck` 为准。
- 代码引用的 `文件路径:行号` 会随 DSH 演进而偏移,定位时以文件名 + 函数/类名为锚点,行号作辅助。
- 发现本文内容过时或有误,在本仓库提 issue 或直接提 PR。
