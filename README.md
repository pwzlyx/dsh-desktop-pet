# dsh-desktop-pet

DeepSeek Harness 的**桌面宠物客户端插件**：网页右下角一个会动的宠物，实时反映智能体状态，并在后台会话结束时用**系统通知 + 提示音**提醒你——无需一直盯着网页。

## 功能

| 状态 | 宠物表现 |
| --- | --- |
| 空闲 | 平静呼吸（蓝紫渐变，微笑） |
| 执行中 | 左右摆动 + 旋转光环 + 「o」嘴型，徽标显示进行中的会话数 |
| 等待你处理 | 抖动 + 橙色，徽标显示「!」，面板列出待批准/待评审/待答复 |
| 完成 | 绿色开心跳动，徽标显示未读完成数 |

- **完成提醒**：非当前会话运行结束（`completed` 提醒位）时，触发系统通知 + 提示音；点击通知或宠物可跳回对应会话。
- **执行进度**：悬停宠物展开面板，列出「执行中 / 需要你处理 / 已完成」的会话标题，以及后台任务数。
- **开关**：面板底部可分别关闭通知与声音（持久化到 `localStorage`）。
- **可访问性**：尊重 `prefers-reduced-motion`，减少动画。

## 安装

### 前置

- 已初始化 `web` profile（`dsh web` 跑过一次即可）。
- `dsh` 命令可用（本机位于 `~/.npm/_npx/*/node_modules/.bin/dsh`）。

### 步骤

1. **安装插件包**到 web profile（任选其一）：

   ```sh
   # A. 推荐：用 dsh plugin 交给 pnpm 处理
   dsh plugin --profile web add /Users/zengleiyixiao1/Documents/DHFolder/dsh-desktop-pet

   # B. 手动：复制到 profile 的 hoisted node_modules（路径以实际为准）
   cp -R dsh-desktop-pet ~/.dsh/profiles/node_modules/
   ```

2. **注册插件行**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，把空数组替换为（或追加）：

   ```yaml
   - insert:
       - id: ui-desktop-pet
         name: 'dsh-desktop-pet'
   ```

   （完整片段见同目录 `cordis.patch.snippet.yml`。）

3. **重启 `dsh web`** 使新的 boot graph 生效：

   ```sh
   # 先停掉当前 dsh web 进程，再启动
   dsh web
   ```

   ⚠️ 重启会中断当前正在进行的会话，请在一个回合结束后从新终端操作。

### 验证

- 重启后刷新网页，右下角应出现宠物。
- 触发一次后台会话结束（例如在另一个会话跑完一个任务），应弹出系统通知并播放提示音。
- 首次点击宠物会请求浏览器通知权限；如通知被浏览器拦截，请在地址栏允许通知后重试。

## 工作原理

- 本插件是**纯客户端 UI 插件**：`package.json` 的 `dsh.client` 声明（`platform: web` + `exports["./client"]`）让宿主扫描并把 `lib/client.js` 打进 `window.__DSH_BOOT__`，经 `/plugins/dsh-desktop-pet/client.js` 注入。
- 注册到全局插槽 `shell.overlay`（`list` + `root` 作用域），组件通过框架注入的 `useSessions` 钩子读取 `SessionListState`（`running` / `pendingInteraction` / `completed` / `jobsBySession`）。
- 完成提醒复用列表层内置的 `completed` 提醒位（「非当前会话跑完且未打开」），在组件里对 `completed` 集合做增量子集对比，仅对**新出现**的完成项各触发一次通知。
- 跳转会调用 `ctx.sessions.open(id)`。

## 目录结构

```
dsh-desktop-pet/
├── package.json              # dsh.client 声明 + exports
├── lib/
│   ├── index.js              # 节点半：空 apply（占位，让 Loader 识别）
│   └── client.js             # 浏览器半：宠物 UI + 状态派生 + 通知
├── cordis.patch.snippet.yml  # 加入 cordis.patch.yml 的片段
└── README.md
```

## 已知限制 / 后续方向

- **错误态**：列表层无逐会话错误字段，当前「完成」提醒不区分成功/失败；可加一个 `session` 作用域伴生插槽读取会话快照（`promptError` / `lastAgentError` / `runningCalls`）来补充「出错」表情与「当前工具」进度。
- **真·桌面悬浮**：本插件在网页内；若要让宠物浮在任意窗口之上，需另做一个连 DSH SSE/API 的原生 App（Electron/Tauri）。
- **标题栏状态**：未改 `document.title`（避免与 shell 的标题投影冲突），改用系统通知承载后台感知。
