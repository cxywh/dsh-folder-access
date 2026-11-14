# dsh-folder-access

在对话里把**本地文件夹**交给 AI：点一下输入框左边的「文件夹」按钮，选一个目录，这个对话里的模型就能浏览、读取并**编辑**其中的文件。

Hand a local folder to a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent from the conversation composer, so it can browse and edit files outside the session workspace.

## 问题

DSH 的文件沙箱默认只允许写入会话工作区：读不受限制，但 `write` / `edit` / 删除、移动都出不去。想改一个工作区之外的项目时，AI 读得到、却改不了。

本插件把「选择文件夹」这一步放进对话本身，选中的目录成为**当前会话**的额外可写根：

```
ctx.sandboxPolicy.registerWritableRoot(session, directory)  // 返回 disposer
```

- 授权只作用于**选中的那个对话**，不影响别的会话；
- 授权是**运行时**的：宿主重启后需要重新授权（会话恢复/分支也不会继承）；
- 授权后，模型的运行时上下文里会出现 `Additional writable directories: [...]`，它能看见并直接读写这些目录；
- 沙箱模式为 `read-only` 时授权不生效（本插件会在界面上提示）；
- Windows 上这份授权只对 Harness 的文件工具（read / write / edit / glob / grep）生效，沙箱内启动的进程仍按原策略执行。

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

界面：输入框左侧的 **文件夹** 按钮 → 选择目录 → 输入框上方出现「已授权」标签，点标签上的 `×` 取消授权。

命令（手输，等价能力）：

| 命令 | 作用 |
| --- | --- |
| `/folder` 或 `/folder list` | 列出当前对话已授权的文件夹 |
| `/folder add` | 弹出目录选择框并授权 |
| `/folder add D:\projects\demo` | 直接授权一个绝对路径 |
| `/folder remove D:\projects\demo` | 取消授权 |
| `/folder clear` | 取消当前对话的全部授权 |

## 实现

- 宿主半侧（`lib/index.js`）：`/folder` 命令 + `GET /dsh-folder-access/state`、`POST /dsh-folder-access/add`、`POST /dsh-folder-access/remove` 三个 exact 路由。UI 与命令走同一套 `grant / revoke` 实现，权限只在这一处被授予。
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
- 一次只授权一个目录；重复授权同一目录是幂等的。
- 授权不落盘：重启 DSH 后重新点一次即可。

## English

A small DSH bundle that lets the user hand a folder to the current conversation from the composer. The host half registers the picked directory with `ctx.sandboxPolicy.registerWritableRoot(session, dir)` — a runtime-only, per-session grant that the fs tools honour (on Windows, file tools only, not sandboxed processes) — and exposes it through a `/folder` command plus three same-origin, loopback-only HTTP routes. The browser half adds a folder button and a row of granted-folder chips to the composer slots. MIT licensed.

## License

MIT
