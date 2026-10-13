# dsh-desktop-pet

DeepSeek Harness 的**鲸鱼娘桌面宠物客户端插件**：一只随智能体状态切换立绘的鲸鱼娘（溟月）住在**桌面独立浮窗**里，实时反映智能体状态、用台词气泡和你互动，并在后台会话结束时用**系统通知 + 提示音**提醒你；v0.2.0 新增 **GLM Coding Plan 额度面板**——悬停面板顶部直接看 5 小时/周窗口用量、剩余积分与重置倒计时；**v0.7.0 起仅浮窗模式**——App 内不再养宠物，GUI 启动即自动唤起浮窗。

## 功能

| 状态 | 宠物表现 |
| --- | --- |
| 空闲 | 平静呼吸（蓝紫渐变，微笑） |
| 执行中 | 左右摆动 + 旋转光环 + 「o」嘴型，徽标显示进行中的会话数 |
| 等待你处理 | 抖动 + 橙色，徽标显示「!」，面板列出待批准/待评审/待答复 |
| 出错 | 红色惊慌抖动（只认最新一轮的回合错误） |
| 完成 | 绿色开心跳动，徽标显示未读完成数 |

- **仅浮窗模式（v0.7.0）**：App 内不再渲染鲸鱼娘——原右下角宠物改为**无头控制器**（状态汇聚、面板发布、完成通知全部保留，只是不再画在 App 里）；GUI 加载后自动唤起桌面浮窗（`POST /pet/float/toggle {action:"show"}`，幂等）。浮窗显隐有三条等效入口：
  - **系统级快捷键 `Alt+Shift+W`**——任何应用在前台都能唤起/隐藏（浮窗进程注册 `globalShortcut`，本地翻转后回写 `POST /pet/float/sync` 保持状态一致）；
  - **输入框旁的 🐳 圆按钮**（会话输入 dock 常驻，点击即切换）；
  - **App 内快捷键 `Alt+Shift+W`**（GUI 页面获得焦点时）。
  - 后端 `toggle` 支持 `{action:"show"|"hide"|"toggle"}`，show/hide 均幂等；鲸鱼娘立绘放大到 132px、浮窗默认 320×640。浏览器（Web GUI）环境无浮窗能力，插件不再提供任何界面。

- **台词气泡**：五种状态各一组台词随机轮播；额度窗口用量 ≥80% 时会插入「⚠ 窗口额度已用 X%」预警台词。
- **Coding Plan 额度面板**：悬停浮窗顶部显示 🐋 Coding Plan 区块——每个窗口（5h/周/MCP月）一条用量条 + 百分比 + 剩余积分 + 重置倒计时，套餐等级（Lite/Pro/Max）随响应展示。
- **完成提醒**：非当前会话运行结束（`completed` 提醒位）时，触发系统通知 + 提示音；点击通知或宠物可跳回对应会话。
- **执行进度**：浮窗面板列出「正在执行的工具 / 目标 / 待办 / 会话列表」，以及后台任务数。
- **点击对话**：点击浮窗立绘展开输入框，直接向当前会话（或「发送到」下拉选中的会话）发送文字或 `/` 指令继续对话。
- **PiP 浮窗（已退役）**：v0.6 及以前浏览器端走 Document PiP 画中画路径；v0.7 起仅浮窗模式，该路径已不再触发（代码暂留作死代码）。
- **桌面独立浮窗（v0.4.0+）**：在 DSH 桌面 App 内弹出一个**真正独立的 OS 置顶小窗**——无边框、全工作区可见、不占任务栏，可拖到 App 外任意位置。由于桌面后端宿主以 `ELECTRON_RUN_AS_NODE=1` 运行（无法在进程内创建窗口），插件会 **spawn 一个独立 Electron 进程**（复用 profile 的 `node_modules/electron` 二进制）承载浮窗：页面从后端 `/pet/float/page` 加载（**不能用 `.html` 后缀**：宿主静态层会抢先接管 `*.html` 路径并返回空 404，浮窗就成一扇全透明空窗）；立绘/台词/额度由 GUI 侧 `POST /pet/float/publish` 发布、浮窗轮询 `/pet/float/live` 消费（立绘按内容哈希增量下发）；回车输入经 `/pet/float/prompt` 入队，GUI 侧每秒取回并送进当前会话；✕（或 Esc）通过 preload IPC 即时隐藏并回写 `/pet/float/sync`。v0.4.2 修复：① ✕ 曾不可点——整个页面是 `-webkit-app-region: drag` 拖拽区，macOS 上拖拽区内的元素收不到 click/hover，✕ 未列入 no-drag 白名单（一切可交互元素都必须进该白名单）；② 全窗加深色圆角卡片底，额度行文字不再白字浮空；③ 悬停立绘弹出状态卡（状态/套餐/各窗口剩余与重置倒计时/当前动作），额度行悬停显示明细。浏览器（Web GUI）环境不具备浮窗能力（v0.7 起无界面）。
- **浮窗面板（v0.5.0；v0.7 起为唯一面板）**：完整的看板分区、配色与交互——🐋 Coding Plan 额度（每窗口用量条/百分比/剩余积分/重置倒计时/套餐等级）、正在执行的工具与思考（第 N 轮）、错误信息、目标与待办进度条、执行中/需要你处理/已完成的会话列表（**点击即跳转对应会话**，经 `/pet/float/open` 回传 GUI 侧 `ctx.sessions.open`）、后台任务数；空闲时同样显示「当前空闲，没有进行中的会话。」；底部输入框回车即向当前会话发送消息。面板数据由 GUI 侧一次性算好整块发布（`publish.panel`），浮窗每秒轮询取增量、每 5 秒本地重绘倒计时。
- **浮窗 ✕ 修复（v0.6.6）**：v0.6.5 把 ✕ 改成绝对定位+半透明（opacity/transition）后，macOS 拖拽区再次吞掉点击（与 v0.4.1 同类）——已改回常规流小条、半透明感用 rgba 颜色实现，不用元素透明度。
- **浮窗视觉改版（v0.6.5）**：去掉整窗大黑底——**鲸鱼娘与台词气泡直接浮在桌面上**（气泡加了描边与投影，任何桌面底色下都可读）；额度/会话/输入区集中到下方一张**深色玻璃卡**（渐变底 + 发丝边框 + 14px 圆角 + 柔和投影 + 顶部高光）；✕ 缩成右上角半透明小点，悬停才显眼。拖拽仍以鲸鱼娘区域为把手。
- **会话定向发送（v0.6.0，v0.6.1/v0.6.2 修复）**：点开输入框，顶部多一个「发送到」下拉——默认「当前会话」，也可选任意执行中/待处理/已完成会话（选项带 ▶/⏸/✓ 前缀与「当前」标记）；选定后鲸鱼娘输入框（以及 `/` 命令）都作用于被选会话，选择持久化；目标会话失效时自动回退当前会话。浮窗底部同样有此下拉，两处互不干扰（各存各的）。
  - v0.6.1 根因修复：会话列表 store 实际没有 `current` / `pendingInteraction` / `completed` 字段（v0.1 遗留的示例形状，导致下拉只剩「当前会话」、发送石沉大海）。当前会话改由 `retainedBy.mainView > 0` 派生（与官方 `SessionTree.mainSessionId` 同义），运行/待处理/完成状态改读槽位标准 props `useSessionStatus`（Map：`running` / `pendingInteraction.kind` / `completionUnread`）；发送对无视图会话经 `ctx.sessions.retainAgentScope(id)` 按需保留 scope，失败会在输入框下显示提示并写控制台。
  - v0.6.2：下拉改为「**工作区 → 会话**」二级结构（与左侧边栏同源：`useWorkspaces` 的 `items[{workspaceId, title, sessionIds}]` 分组 + 未分组散会话兜底），列出**全部**可见会话而非仅运行/待处理/已完成；过滤规则与侧边栏一致（子代理会话、空白占位、归档会话不显示），标签取 `title/displayTitle`（无标题显示「（未命名会话）」，不再裸显 session ID）；浮窗下拉用原生 `optgroup` 呈现同样分组。
- **会话悬停详情（v0.6.0，v0.6.3 修复）**：浮窗会话行悬停（停留 450ms）即可查看该会话**最近一次提示词**与**当前输出**（生成中会标注「生成中」），以内嵌弹层展示。数据来自各会话视图的隐藏桥接组件（`EnrichBridge`）——只覆盖已打开过视图的会话，其余显示「暂无预览」。
  - v0.6.3 根因修复：v0.6.0 读的是 Session face 快照的 `nodes`，但生产中该快照**根本没有这个字段**（那是 chat 视图源的数据，官方 v0.1 示例形状在生产恒为 `undefined`），因此悬停详情一直为空。现改从与 ChatView 同源的 `ctx.uiConversation.binding(sessionId).target("chat")` 快照提取（`order` + `nodes.get(key)`，用户消息 `user/steering` 取 `data.content` 文本块、助手输出 `assistant-step` 取 `data.blocks` 文本块），旧形状仅作兜底。
- **额度进度条（v0.6.3 修复）**：浮窗的进度条填充是 `<span>`（inline 元素忽略 height/width，轨道可见但填充不可见）——补 `display:block`；三处配色统一为用户规格：≤50% 绿、50%–85% 橙、>85% 红（App 面板 / 浮窗 / Document PiP 一致）。
- **浮窗交互打磨（v0.6.4）**：① 悬停详情改为「**停留 450ms** 才弹出」——鼠标扫过不再误触（快速划过实测不弹、停留才弹）；② 详情弹层改为**锚定在会话行旁的浮层**（绝对定位 + 阴影），不再插在顶部挤压面板内容，行下方放不下时自动翻到行上方，面板每秒重渲染后自动重新锚定（行已消失则收起）；③ 输入框从一窄条 `<input>` 换成 **3 行高的 `<textarea>`**（Enter 发送、Shift+Enter 换行，上限放宽到 500 字）。
- **通知/声音开关**：默认全开，状态持久化在 `localStorage`（v0.7 起面板 UI 随 App 内宠物移除，如需关闭可手改该键）。
- **可访问性**：尊重 `prefers-reduced-motion`，减少动画。

## 安装

v0.2.1 起插件自带 `dsh.bundle.patch`（包根 `cordis.patch.yml`）：进入 `dsh.profile.bundles` 清单即自动挂载，**不再需要**手动往 profile 的 `cordis.patch.yml` 加 insert 行。

### 前置

- 已初始化目标 profile（如 desktop / web，对应 App 至少跑过一次）。
- profile 内有可用的 pnpm（`npx --yes pnpm@11` 亦可）。

### 步骤

1. **安装插件包**到目标 profile：

   ```sh
   # 推荐：dsh plugin（自动完成依赖安装 + bundles 注册）
   dsh plugin --profile desktop add git@github.com:pwzlyx/dsh-desktop-pet.git
   # 或 HTTPS / 本地路径 / npm tarball：
   dsh plugin --profile desktop add https://github.com/pwzlyx/dsh-desktop-pet
   dsh plugin --profile desktop add ./dsh-desktop-pet
   dsh plugin --profile desktop add zengleiyixiao-dsh-desktop-pet-0.7.0.tgz

   # 手动等价操作（dsh plugin 不可用时）：
   cd ~/.dsh/profiles/desktop
   npx --yes pnpm@11 add https://github.com/pwzlyx/dsh-desktop-pet
   # 然后编辑 package.json，把 "@zengleiyixiao/dsh-desktop-pet" 追加进
   # dsh.profile.bundles 数组 —— bundle 层会自动 insert 插件行并挂载
   ```

2. **（可选）按 profile 覆盖配置**：编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，
   用同 id 行做定向覆盖（用户层行按 id patch bundle 行，不会双挂载）：

   ```yaml
   - id: ui-desktop-pet
     name: '@zengleiyixiao/dsh-desktop-pet'
     config:
       quota:
         provider: zai-coding-cn   # 或 zai（国际版）
         type: 1                   # 1=个人套餐 2=团队套餐
   ```

3. **重启 DSH App** 使新的 boot graph 生效。

   ⚠️ 重启会中断当前正在进行的会话，请在一个回合结束后操作。

### 验证

- 重启 DSH App 后，**桌面浮窗自动弹出**（鲸鱼娘立绘 + 台词 + 额度/会话面板），输入框旁出现 🐳 圆按钮。
- 按 `Alt+Shift+W`（任意应用前台均可）或点 🐳 按钮，浮窗应即时隐藏/唤起。
- 触发一次后台会话结束（例如在另一个会话跑完一个任务），应弹出系统通知并播放提示音。
- 首次会请求系统通知权限；如被拒绝，请在系统设置里对 DSH App 允许通知后重试。

## Coding Plan 额度显示（v0.2.0，可选）

额度查询在**宿主 Node 进程**里完成（API Key 不进浏览器），通过同源路由 `/pet/quota` 提供给面板；国内新积分套餐（2026-07-30 改版后）与国际 z.ai 均支持。不配置时面板显示配置引导，不影响其他功能。

### 配置

1. 编辑对应 profile 的 `~/.dsh/profiles/<profile>/cordis.patch.yml`，给插件行加 `config.quota`：

   ```yaml
   - id: ui-desktop-pet
     name: '@zengleiyixiao/dsh-desktop-pet'
     config:
       quota:
         provider: zai-coding-cn     # 或 zai（国际）
         organization: org-xxxxxxxx  # 国内积分套餐必填
         project: proj_xxxxxxxx      # 国内积分套餐必填
         type: 2                     # 1=个人套餐 2=团队套餐
   ```

2. **API Key** 用环境变量提供（不要明文写进 yml）：

   ```sh
   export ZAI_CODING_CN_API_KEY=你的key   # zai 用 ZAI_API_KEY
   ```

   或写在 `quota.apiKey`（优先级：`quota.apiKey` > 环境变量）。

3. 重启 DSH（让宿主进程拿到环境变量与新配置）。

### organization / project / type 怎么拿？

浏览器登录 [bigmodel.cn](https://bigmodel.cn) → 进入「Coding Plan」页面 → 打开 DevTools Network → 任选一条发往 `/api/monitor/...` 的请求，看请求头：`bigmodel-organization`（org-…）、`bigmodel-project`（proj_…）；`type` 对应页面左上角选中的「个人/团队」套餐。

### 额度接口语义

- 端点：`GET https://bigmodel.cn/api/monitor/usage/quota/limit?type={1|2}`（z.ai 为 `https://api.z.ai/api/monitor/usage/quota/limit`，Bearer 认证）。
- 响应 `data.limits[]`：`CREDIT_LIMIT`/`TOKENS_LIMIT` 行按 `unit`（3=5 小时窗、6=周窗）标注；`TIME_LIMIT` 是月度 MCP/工具额度；`percentage` 缺失时用 `currentValue/usage` 推导。

## 工作原理

- 本插件是**客户端 UI 插件**：`package.json` 的 `dsh.client` 声明（`platform: web` + `exports["./client"]`）让宿主扫描并把 `lib/client.js` 打进 `window.__DSH_BOOT__`，经 `/plugins/<pkg>/client.js` 注入。
- 注册到全局插槽 `shell.overlay`（`list` + `root` 作用域）；v0.7 起该组件为**无头控制器**（渲染 null，仅做状态汇聚/面板发布/完成通知），App 内 UI 只剩注册到 `conversation.input.dock` 的 🐳 按钮 + `Alt+Shift+W` 快捷键。会话状态读 `useSessions` + `useSessionStatus`（Map）+ `useWorkspaces`，当前会话由 `retainedBy.mainView > 0` 派生。
- 完成提醒复用列表层内置的 `completed` 提醒位（「非当前会话跑完且未打开」），在组件里对 `completed` 集合做增量子集对比，仅对**新出现**的完成项各触发一次通知。
- 跳转会调用 `ctx.sessions.open(id)`；输入框发消息走 `session.prompt()` / `session.command()`。
- 额度轮询在节点半（`lib/index.js`，`inject: ["webServer"]`）：启动即拉一次，每 `intervalSeconds`（默认 300s）后台刷新；面板每 60s 拉宿主缓存，倒计时本地 30s 重绘。响应永不回显 Key。

## 目录结构

```
dsh-desktop-pet/
├── package.json              # dsh.client 声明 + exports + bundles 清单
├── cordis.patch.yml          # bundle 自带挂载行（进 dsh.profile.bundles 即自动挂载）
├── lib/
│   ├── index.js              # 节点半：quota 轮询 + /pet/quota + /pet/float/* 路由（toggle/sync/publish/live/prompt/open）
│   ├── quota.js              # 额度响应解析纯函数（双方言）+ 格式化
│   ├── client.js             # 浏览器半：无头控制器 + 🐳 按钮 + 状态派生 + 通知 + 浮窗数据发布
│   ├── float.html            # 浮窗页面（立绘/气泡/玻璃卡面板/输入框）
│   └── float-app/            # 独立 Electron 浮窗宿主（spawn 进程；globalShortcut Alt+Shift+W）
├── test-render-sim.mjs       # 浏览器半渲染模拟（假 React + fake fetch 捕获）
├── test-node-half.mjs        # 节点半集成自测（quota + 浮窗显隐状态机）
├── test-float-node.mjs       # 浮窗路由无 Electron 自测
├── test-float-spawn.mjs      # 真 Electron 冷启动冒烟（stub 后端）
└── README.md
```

## 版本历史

- **0.7.0**（2026-10-13）：**仅浮窗模式**——去掉 App 内宠物（无头控制器保留通知/发布）；GUI 启动自动唤起浮窗；显隐三入口（系统级/App 内 `Alt+Shift+W` + 🐳 按钮）；`toggle` 支持 `action` 幂等语义 + `/pet/float/sync` 状态回写；立绘 92→132px、浮窗 320×640。
- **0.6.x**：浮窗视觉改版（去大黑底、玻璃卡）与 ✕ 修复、悬停停留 450ms、锚定弹层、3 行输入框、工作区分组下拉、chat 视图源悬停详情、进度条三色。
- **0.5.0**：浮窗面板全量化（额度/工具/待办/会话列表/跳转/输入）。
- **0.4.x**：桌面独立浮窗（spawn Electron 进程、可拖出 App 外、置顶全工作区）。
- **0.2.x**：GLM Coding Plan 额度面板（国内/国际双方言）。
- **0.1.x**：初版 App 内看板娘（状态立绘/台词/通知/输入框）。

## 已知限制 / 后续方向

- **错误态**：列表层无逐会话错误字段，当前「完成」提醒不区分成功/失败。
- **快捷键冲突**：`Alt+Shift+W` 为系统级注册，若被其他应用占用，浮窗进程注册会失败（写 stderr 日志），App 内快捷键与 🐳 按钮不受影响。
- **浏览器（Web GUI）**：v0.7 起无任何界面（浮窗依赖桌面 Electron）。
- **浮窗进程无自动更新**：插件升级后需重启 DSH App，旧浮窗子进程随宿主退出。
