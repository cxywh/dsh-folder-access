# dsh-folder-access

在对话里把**本地文件夹**交给 AI：点一下输入框左边的「文件夹」按钮，选一个目录，AI 就能浏览、读取并**编辑**其中的文件——而且这个授权会记住，**新开的对话里模型一上来就知道**，不用你再提醒。

Hand a local folder to a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent from the conversation composer, so it can browse and edit files outside the session workspace. The grant persists, so a conversation started later already knows the folder.

## 问题

DSH 的文件沙箱默认只允许写入会话工作区：读不受限制，但 `write` / `edit` / 删除、移动都出不去。想改一个工作区之外的项目时，AI 读得到、却改不了。

本插件把「选择文件夹」这一步放进对话本身。选中的目录会登记成**当前 profile 的已授权文件夹**，并注入每一个活着的会话：

```
ctx.sandboxPolicy.registerWritableRoot(session, directory)  // 返回 disposer
```

- 授权**按 profile 持久保存**（`$DSH_HOME/folder-access/<profile>.json`）：新开的对话、重启后的对话都自动带上，模型在它的运行时上下文里直接看到 `Additional writable directories: [...]`；
- 授权仍然是**逐会话注入**的：沙箱策略每次请求重新解析，撤销后立即失效；
- 沙箱模式为 `read-only` 时授权不生效（本插件会在界面上提示）；
- Windows 上这份授权只对 Harness 的文件工具（read / write / edit / glob / grep）生效，沙箱内启动的进程仍按原策略执行。

> 升级说明：0.1.x 的授权只活在单个对话里，重启就没了；0.2.0 起改为持久保存并自动带到新对话。`/folder clear` 或点标签上的 `×` 会真正撤销（同时改写 state 文件）。

## 安装

要求 DSH `0.2.2-rc.3`（`package.json` 里用 `dsh.compatibility.dshReleases` 声明）。
```bash
git clone https://github.com/cxywh/dsh-folder-access.git
```

然后在 DSH 的插件管理里以本地包安装这个目录（`install_bundle`，目标传克隆下来的绝对路径），或把它加进 profile：

```jsonc
// profile 的 package.json
{
  "dependencies": { "dsh-folder-access": "link:D:/path/to/dsh-folder-access" },
  "dsh": { "profile": { "bundles": ["dsh-folder-access"] } }
}
```

安装后**刷新一次页面**：客户端半侧是页面加载时注册插槽的。

## 用法

界面：输入框左侧的 **文件夹** 按钮 → 选择目录 → 输入框上方出现「已授权文件夹」标签（每个对话都会显示同一份列表），点标签上的 `×` 取消授权。

命令（手输，等价能力）：

| 命令 | 作用 |
| --- | --- |
| `/folder` 或 `/folder list` | 列出已授权的文件夹（含新对话的） |
| `/folder add` | 弹出目录选择框并授权 |
| `/folder add D:\projects\demo` | 直接授权一个绝对路径 |
| `/folder remove D:\projects\demo` | 取消授权（所有对话立即失效） |
| `/folder clear` | 撤销全部授权 |

授权之后**不必重述**：新开的对话里，模型的运行时上下文已经列出这些目录，可以直接读写。

## 实现

- 宿主半侧（`lib/index.js`）：`/folder` 命令 + `GET /dsh-folder-access/state`、`POST /dsh-folder-access/add`、`POST /dsh-folder-access/remove` 三个 exact 路由。UI 与命令走同一套 `grant / revoke` 实现，权限只在这一处被授予；持久列表在这里读写，`session/created` 在这里注入。
- 浏览器半侧（`client/client.js`）：注册到 `conversation.input.left`（按钮）与 `conversation.input.dock`（已授权标签行）两个插槽，只调用上面三个路由。
- 路由只接受 loopback 主机名与同源请求（`sec-fetch-site` 不是 `cross-site`）；它们不经过 `/api` 网关，因此自带这层校验。

```
dsh-folder-access/
├── package.json          # bundle + client 清单
├── cordis.patch.yml      # 往 profile 里插一条插件记录
├── lib/index.js          # 宿主：/folder 命令、三个路由、registerWritableRoot
├── client/client.js      # 浏览器：两个插槽
├── locale/{zh,en}.json   # 插件卡片标题与描述
├── icon.svg
├── docs/DETAIL.md
└── README.md
```

## 限制

- 目录选择框由宿主的 `directoryPicker` 组合提供（桌面宿主是系统对话框）；如果当前组合只提供浏览器版选择器，按钮会退化为手动输入路径。
- 一次授权一个目录；重复授权同一目录是幂等的。
- 授权是 **profile 级** 的：同一 profile 下的所有对话共享一份列表，不同 profile 各存一份（`$DSH_HOME/folder-access/<profile>.json`）。想彻底清掉，用 `/folder clear` 或删掉这个文件。
- 撤销是立即的：所有活着的会话里，该目录的写权限当场释放。

## 排错：`HTTP 405`

0.1.1 之前，宿主在 `apply()` 里直接读 `webServer` / `commands`。如果 loader 先加载插件、后创建这两个服务，注册会被静默跳过：`/folder` 不存在，点文件夹按钮的 `POST` 落到外壳的静态处理器，于是弹出 `HTTP 405`（`Allow: GET, HEAD`）。现在改为 `ctx.inject(['commands'])` / `ctx.inject(['webServer'])`，服务就绪后再挂载，与加载顺序无关；升级后请重启一次 DeepSeek Harness。

## 排错：新对话里模型不知道已授权的文件夹

0.1.x 的授权只注入当时那个会话，新对话自然一无所知。0.2.0 起：

- 宿主把授权写进 `$DSH_HOME/folder-access/<profile>.json`，插件加载时就读回来；
- 监听 `session/created`（`{ global: true }`），新会话在第一次模型请求之前就拿到全部授权（`ctx.sandboxPolicy.registerWritableRoot`）；
- 授权变化时对所有活着的会话同步注入/撤销；
- 撤销会同时改写文件，所以下次启动不会再冒出来。

如果新对话里仍然看不到 `Additional writable directories`，按这个顺序查：插件是否 `active`（`plugin_manager list_plugins`）、`$DSH_HOME/folder-access/<profile>.json` 是否存在且能解析、当前会话沙箱模式是否为 `workspace-write`。

## English

A small DSH bundle that lets the user hand a folder to the agent from the composer. The picked directory is remembered per profile (`$DSH_HOME/folder-access/<profile>.json`) and registered with `ctx.sandboxPolicy.registerWritableRoot(session, dir)` in every session — including sessions created later, so a new conversation already knows the folder without being reminded. Revoking releases every live session at once. The host exposes a `/folder` command plus three same-origin, loopback-only HTTP routes; the browser half adds a folder button and a row of granted-folder chips to the composer slots. On Windows the grant applies to the file tools only, not to sandboxed processes. MIT licensed.

## License

MIT
