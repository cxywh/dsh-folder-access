# dsh-folder-access

在对话里把**本地文件夹**交给 AI：点一下输入框左边的「文件夹」按钮，选一个目录，AI 就能浏览、读取并**编辑**其中的文件。授权的那一刻，插件就把这个目录写进模型的运行时上下文——不用你再补一句「我刚授权了一个文件夹」或「看看你有哪些授权目录」。

Hand a local folder to a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent from the conversation composer, so it can browse and edit files outside the session workspace. The grant is injected into the model's runtime context immediately, so the next reply already knows the folder.

## 问题

DSH 的文件沙箱默认只允许写入会话工作区：读不受限制，但 `write` / `edit` / 删除、移动都出不去。想改一个工作区之外的项目时，AI 读得到、却改不了。

本插件把「选择文件夹」这一步放进对话本身。选中的目录会登记到**当前会话**的 workspace-write 集合：

```
ctx.sandboxPolicy.registerWritableRoot(session, directory)  // 返回 disposer
```

- 授权只对**当前对话**生效：同一个 profile 里的其他对话不受影响，对话结束（或撤销）后释放；
- 同时注册一条运行时上下文 `folder-access:grants`（紧随 `sandbox:policy`），把授权目录和「可以直接读写、不要再问路径」的说明一起交给模型，所以**下一次请求就能看到**；
- 沙箱模式为 `read-only` 时授权不生效（插件会在界面上提示）；
- Windows 上这份授权只对 Harness 的文件工具（read / write / edit / glob / grep）生效，沙箱内启动的进程仍按原策略执行。

## 模型怎么知道的

`sandbox:policy` 原本就会把 `Additional writable directories: [...]` 写进运行时上下文，但那句话只说明「多了一个可写目录」，模型不一定把它理解为「用户已经授权，我现在可以动手」。本插件额外贡献一段更明确的上下文（`lib/index.js` 里的 `renderGrantContext`）：

```
Folder access — the user granted these folders to this conversation just now. You may read and
write files inside them with the file tools directly; do not ask the user for the path and do not
ask whether a folder was granted.
- D:\projects\demo
```

它是**动态 context**（`systemPrompt.context({ text: (context) => ... })`），每次模型请求都会重新求值，因此授权发生在两轮之间也没关系——下一轮就已经在里面了。没有授权时这段是空字符串，不占上下文。

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

界面：输入框左侧的 **文件夹** 按钮 → 选择目录 → 输入框上方出现「已授权文件夹」标签（只列当前对话的授权），点标签上的 `×` 取消授权。

命令（手输，等价能力）：

| 命令 | 作用 |
| --- | --- |
| `/folder` 或 `/folder list` | 列出当前对话已授权的文件夹 |
| `/folder add` | 弹出目录选择框并授权 |
| `/folder add D:\projects\demo` | 直接授权一个绝对路径 |
| `/folder remove D:\projects\demo` | 取消当前对话对这个目录的授权 |
| `/folder clear` | 撤销当前对话的全部授权 |

授权之后**不必重述**：模型的运行时上下文已经列出目录，并明确说明可以直接读写。

## 实现

- 宿主半侧（`lib/index.js`）：`/folder` 命令 + `GET /dsh-folder-access/state`、`POST /dsh-folder-access/add`、`POST /dsh-folder-access/remove` 三个 exact 路由，外加一条 `folder-access:grants` 运行时上下文。UI 与命令走同一套 `grant / revoke` 实现，权限只在这一处被授予。
- 浏览器半侧（`client/client.js`）：注册到 `conversation.input.left`（按钮）与 `conversation.input.dock`（已授权标签行）两个插槽，只调用上面三个路由。
- 路由只接受 loopback 主机名与同源请求（`sec-fetch-site` 不是 `cross-site`）；它们不经过 `/api` 网关，因此自带这层校验。

```
dsh-folder-access/
├── package.json          # bundle + client 清单
├── cordis.patch.yml      # 往 profile 里插一条插件记录
├── lib/index.js          # 宿主：/folder 命令、三个路由、上下文注入
├── client/client.js      # 浏览器：两个插槽
├── locale/{zh,en}.json   # 插件卡片标题与描述
├── icon.svg
├── docs/DETAIL.md
└── README.md
```

## 限制

- 目录选择框由宿主的 `directoryPicker` 组合提供（桌面宿主是系统对话框）；如果当前组合只提供浏览器版选择器，按钮会退化为手动输入路径。
- 一次授权一个目录；重复授权同一目录是幂等的。
- 授权不写入会话日志、不跨对话继承：新对话要重新授权（这是有意为之，避免在别处静默拿到写权限）。
- 撤销是立即的：`registerWritableRoot` 返回的 disposer 当场释放该目录的写权限。

## 排错：`HTTP 405`

0.1.1 之前，宿主在 `apply()` 里直接读 `webServer` / `commands`。如果 loader 先加载插件、后创建这两个服务，注册会被静默跳过：`/folder` 不存在，点文件夹按钮的 `POST` 落到外壳的静态处理器，于是弹出 `HTTP 405`（`Allow: GET, HEAD`）。现在改为 `ctx.inject(['commands'])` / `ctx.inject(['webServer'])` / `ctx.inject(['systemPrompt'])`，服务就绪后再挂载，与加载顺序无关；升级后请重启一次 DeepSeek Harness。

## 排错：授权了但模型还是问路径

按顺序查：

1. 插件是否 `active`：`plugin_manager list_plugins` 里看 `include:folder-access`；
2. 界面上是否出现「已授权文件夹」标签——出现说明宿主路由生效；
3. 当前会话沙箱模式是否为 `workspace-write`（`read-only` 下授权不写权限）；
4. 授权是在**这个对话**里做的吗？0.3.0 起授权不跨对话；
5. 若用 `/folder add` 之后模型仍问路径，确认宿主已重启（旧进程里没有 `folder-access:grants`）。

## English

A small DSH bundle that lets the user hand a folder to the agent from the composer. The picked directory is registered with `ctx.sandboxPolicy.registerWritableRoot(session, dir)` for the current conversation, and the same list is published as the `folder-access:grants` runtime context — a dynamic `systemPrompt.context` entry that is re-evaluated on every model request. The next reply therefore already knows which folders it may read and write, without the user repeating the grant. The host exposes a `/folder` command plus three same-origin, loopback-only HTTP routes; the browser half adds a folder button and a row of granted-folder chips. On Windows the grant applies to the file tools only, not to sandboxed processes. MIT licensed.

## License

MIT
