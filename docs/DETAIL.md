# 文件夹授权（Folder access）

## 为什么需要它

DSH 的文件沙箱默认把写操作限制在会话工作区里：`write` / `edit` / 删除、移动都只能落在工作区内。
读不受限制，可是当你想让 AI 改一个工作区之外的项目时，它读得到、却改不了。

这个插件把「选择文件夹」这一步放进对话本身：输入框左侧的文件夹按钮，或者 `/folder add`，
选中的目录会成为**当前对话**的额外可写根；同时插件把这份清单写进模型的运行时上下文，
所以下一轮请求模型就已经知道「用户授权了哪些目录、可以直接读写」，不需要用户再解释。

## 行为

- 授权只作用于发起它的会话：`ctx.sandboxPolicy.registerWritableRoot(session, dir)` 返回的 disposer 在撤销或会话结束时释放；
- 插件注册一条动态运行时上下文 `folder-access:grants`（`systemPrompt.context`，排序紧随 `sandbox:policy`）：

  ```
  Folder access — the user granted these folders to this conversation just now. You may read and
  write files inside them with the file tools directly; do not ask the user for the path and do not
  ask whether a folder was granted.
  - D:\projects\demo
  ```

  它的 `text` 是一个函数，每次模型请求重新求值，因此授权的当轮之后的第一次请求就会带上；没有授权时返回空串，不占上下文；
- 沙箱自身的 `sandbox:policy` 仍会列出 `Additional writable directories: [...]`，两者互补：一条是策略事实，一条是「可以动手」的指令；
- 撤销是即时的：调用 disposer，该目录的写权限当场释放，上下文里对应的行也随之消失；
- 沙箱模式为 `read-only` 时授权不生效，插件会明确告知；
- Windows 上这份授权只对 Harness 的文件工具生效，沙箱内启动的子进程仍按原策略执行。

## 入口

| 入口 | 位置 |
| --- | --- |
| 文件夹按钮 | 输入框左侧工具行 |
| 已授权标签 | 输入框上方（只列当前对话），点 `×` 取消 |
| `/folder add [路径]` | 手输命令，弹出系统目录选择框或直接给绝对路径 |
| `/folder list` / `remove` / `clear` | 查看与撤销 |

## 边界

- 一次授权一个目录；重复授权同一目录是幂等的；
- 选择框由宿主的 `directoryPicker` 提供，浏览器版选择器下会退化为手动输入路径；
- 路由只接受 loopback 主机名与同源请求，不经过 `/api` 网关；
- 授权不写会话日志、不跨对话继承：新对话需要重新授权，避免在别处静默获得写权限。
