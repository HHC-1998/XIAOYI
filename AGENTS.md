# AGENTS.md — 小亦（XIAOYI）项目约定

> 给 AI 协作开发者的项目速览与硬性约定。本文档保持精简；与 XIAONA 的差异说明见文末。

## 项目定位

小亦是一个**纯聊天 + 三层记忆**的个人 AI 助手，**不执行任何功能任务**（无多 Agent 执行、无任务工具、无飞书、无 CLI），**不接任何云端 API**（模型全部本地，见下；唯一例外：TTS 走 edge-tts 在线合成，用户 2026-09-03 确认，见 `01_单Agent聊天助手/04_语音输入与识别详解.md` §5/§9）。它脱胎于 XIAONA 项目的聊天链路，数据库/容器/卷名全部独立（`xiaoyi_*`），与 XIAONA 完全隔离。

视觉能力（12_视觉功能详解）是聊天陪伴的**感官扩展**而非功能任务：视觉模型看图转文字描述，小亦模型用人设口吻说话，不改变"纯聊天"定位。

## 项目结构

```
backend/             # FastAPI 后端（app/core 记忆引擎、app/api 路由、app/db 三层存储）
frontend/            # React 18 + Vite 前端（pages 聊天/图谱/桌面助手/每日精彩/设置）
start.py             # 一键启动（compose up -d --build + 健康检查 + 打开浏览器）
训练/                # 本地微调说话风格模型手册（LLaMA-Factory + Ollama 导入）
项目计划/
├── 01_单Agent聊天助手/   # 设计文档（01~12），代码注释章节溯源见对应文档名编号
└── 所遇问题及解决方案/    # 按日期归档的问题台账
```

## 核心架构

```
chat.py → memory_engine → llm / sql / chroma / neo4j
```

- `backend/app/core/memory_engine.py` 是核心：对话、记忆检索、知识图谱抽取、遗忘。
- 三层记忆：PostgreSQL（会话/消息，`app/db/sql_models.py`）、ChromaDB（向量，`app/db/chroma_client.py`）、Neo4j（图谱，`app/db/neo4j_client.py`）。
- 模型固定本地三槽位（env 写死，见 `01 §4` / `02 §7`）：chat=本地微调说话风格模型（`XIAOYI_CHAT_MODEL`）、extract=本地千问（`XIAOYI_EXTRACT_MODEL`）、embedding=本地 bge（`XIAOYI_EMBEDDING_MODEL`），统一走本地 Ollama（`XIAOYI_OLLAMA_BASE_URL`，容器内自动解析宿主机），**不接任何云端 API**。
- 视觉为第四槽位（`XIAOYI_VISION_MODEL`，默认 `qwen2.5vl:3b`）：双模型级联（视觉模型看图转文字描述 → 小亦模型用小亦口吻回复），见 `12_视觉功能详解.md`。

## 硬性约定

1. **文档反哺（实时、无需提醒）**：代码改动必须同步更新代码注释中的章节溯源（如 `01 §5.2`）与 README；不得只改代码不留文档。**每次代码/结构变动、新问题出现与解决后，立即同步更新 `项目计划/` 下对应模块详解（尤其 `01_单Agent聊天助手/`）与 `所遇问题及解决方案/` 当日台账，不需要用户提醒。** `项目计划/README.md` 是唯一事实源——操作手册（如 `训练/README.md`）删掉后，仅凭项目计划必须能看懂全貌。
2. **文档优先级（核心约定）**：`01_单Agent聊天助手/`（模块设计文档）**重要性高于** `所遇问题及解决方案/`（问题台账）。台账只作实时流水记录；凡遇到**麻烦/影响大的问题、改动面大的重构**，必须**及时把结论沉淀回 `01_` 对应模块文档**（新增/更新小节），不能只留在台账里。判断标准：问题解决后，`01_` 里的对应设计是否还自洽、是否覆盖了新认知。

## 省 token 工作流（硬性约定）

> 2026-08-27 起，用户确认的省 token 工作流，与 XIAONA 对齐。所有协作开发必须遵守。

### 总原则

- **开工前必须先读本节再动手**。Agent 只做「精准活」：改代码、反补文档、给可复制的命令。凡等待/部署/启动/训练/下载/构建/盯守日志类操作，一律只给命令不代跑、不等待、不轮询——用户手动执行，省 token、省时间。
- **凡「长时间等待」或「循环批量」类操作，一律不代跑**：Agent 只给出可复制的命令，由用户手动执行；Agent **不等待其完成、不轮询进度、不 sleep 干等**。
- Agent 只做几秒钟内能出结果的快速只读检查（Grep/Glob、读小文件、`ollama list` 等）。

### 高消耗 token 操作清单（禁止自动执行，只给命令）

| 操作 | 为什么耗 | 正确做法 |
|---|---|---|
| 模型/数据下载（`ollama pull`、`modelscope download`、`huggingface-cli`） | 大文件下载可达数小时，等待即烧 token | 只给完整命令，用户自己跑；网络慢时提示国内镜像 |
| 批量语料生成（如循环调 Ollama 生成对话数据） | 逐场景多次推理，全量数十~数百次调用，单次可数分钟 | 只给命令+参数说明（如每批条数），不代跑；用户小样本自测后自行决定是否全量 |
| 模型训练（`llamafactory-cli train`） | 动辄数十分钟到数小时 | 只给命令，不代跑、不轮询 |
| 容器构建/启动/健康检查（`docker compose`、`start.py`） | 拉镜像+构建+启动+等待就绪，耗时长 | 只给命令，用户自己跑 |
| 前端构建（`npm install` / `npm run build`） | 依赖安装+构建数分钟起 | 只给命令，不代跑 |
| 纯等待类（`sleep`、长时间 `await`/轮询后台任务） | 无信息产出，纯烧 token | 一律不执行 |
| 长耗时命令的进度盯守 | 反复查看输出=重复烧 token | 启动类命令交给用户，Agent 不盯守 |

### 给出的命令必须是「一键可复制」的完整命令

- 含全部参数（路径、模型名、数据文件），用户粘贴即可运行。
- 多条命令按顺序编号，注明每条预期耗时与产出文件。
- 命令若可能中途失败（如网络中断），附一句恢复方法（重跑同命令通常可断点续传）。
- **Windows/PowerShell 命令用单条或 `;` 分隔**，不用 `&&`（该环境不支持）；`cp` 用 `Copy-Item`。
- **启动类命令一律以 `python start.py` 为准**（一键拉起 docker 全部服务，前端依赖在镜像构建时自动安装），**不拆成 `npm install` / `npm run build` 再启动**——那些是本地开发验证命令，不是启动流程。

### 其他（承接既有约定）

- **后端验证只跑静态检查**：改动后执行 `python -m compileall -q backend/app`；**不重建 Docker 容器、不做容器内实测、不等待健康检查**——运行验证由用户手动 `python start.py` 完成，无需代跑。
- **前端不代跑构建**：前端改动由用户自行构建确认（本地开发：`cd frontend; npm install; npm run build`；整套启动：`python start.py`），Agent 不代跑。
- **精准探索代码**：用 Grep/Glob 定位、只读最小片段，**不无谓通读大文件**（大文档/台账先 Grep 命中行附近再读，不整读）。
- **不虚构验证结论**：台账「验证」栏如实写「静态检查通过，待用户手动启动实测」，不编造运行结果。
- **文档操作省 token**：引用已有章节/文档路径代替重复粘贴代码块；改动文档时只更新受影响小节，不整篇重写。
- **维持「文档反哺」文化**：代码改动同步更新 `项目计划/` 对应文档（章节号见对应文档名编号）与 AGENTS.md，保持精炼、不重复。**实时反哺是常态行为**：每完成一次改动/排障，当场更新模块详解 + 当日台账，见 `项目计划/README.md` 维护约定。

## 后端约定

- **SSE 流式契约**（`api/chat.py`）：帧格式为 `data: {json}\n\n`，包括 `{session_id}` 首帧、`{delta, thinking}` 增量帧、`{error, code}` 错误帧、`data: [DONE]` 收尾帧。
- **思考落库**：DeepSeek `reasoning_content` / Ollama `thinking` 存入 `Message.thinking`，SSE 以 `{thinking}` 帧透传；前端不展示思考，仅用于落库。
- **快速回复**：聊天为第一要务，网页与桌面助手所有入口统一 `low` 浅度思考快速回话，不做深度思考。
- **对话模型未配置**：抛 `ChatModelNotConfigured` → 前端引导到设置页，逻辑保留（env 写死后恒已配置，该分支仅作兜底）。
- **登录/鉴权**：`JWT_SECRET` 生产环境必须显式配置（默认值仅限开发）。
- **清空数据**（`memory_engine.clear_messages_and_sessions`）按外键依赖顺序删除 Message → Session；数据管理页「清空」为硬删除。
- **视觉桥接**（12 §8.3）：对话模型不支持图片（`VisionNotSupportedError`）时，先调视觉模型 `describe_image` 转文字描述再发给对话模型，而非直接回"不支持图片"；视觉模型也不可用才退回聊天式回复。`vision_analyze` / `vision_proactive_talk` 为视觉对话统一入口（触发/上传/主动搭话共用）。

## 前端约定

- **打字机渲染**（`pages/Chat.jsx`）：delta 先入队（`pendingRef`），30ms 定时器逐字 reveal；前端不采集思考（`onThinking` 空实现，`ThinkingBlock` 已移除），占位统一「思考中…」；流结束时 `flushPending()` 一次性补全（防止单帧整段回复渲染成空白气泡）。
- **SSE 解析**（`api/chat.js`）：`streamChat` 返回 AbortController，离开页面时中止旧流（单会话下无"切会话"中止）；错误帧后必须 `reader.cancel()` 释放连接。
- **会话恢复（单会话模式，2026-09-03 起）**：web 聊天页沉浸式单会话——主会话 id 持久化在 localStorage（`xiaoyi_main_session_{user.id}`），无会话记录进欢迎态、首条消息懒创建（`ensureMainSession` 防双开会话）；`onSession` 自愈只同步 ref + localStorage 不 setSessionId；桌面助手 `desktop_session_id_{user.id}` 独立。旧多会话数据保留在数据库，前端不再提供切换入口（07 §9）。
- **Q 版星夜主题（2026-09-03 起）**：全前端统一「星空深蓝紫 + 粉紫」皮肤（配色/动效/公共类见 05 §8）；网页聊天页形象 = `public/avatars/xiaoyi.png`（替换同名文件即可换形象），桌面助手 = Live2D（11 文档）。
- **附件收窄为仅图片**：`ChatInput` `ACCEPT='image/*'`，缩略图预览；语音/发送按钮保留（12 §9.2）。
- **品牌**：产品名「小亦」，英文标识 XIAOYI；图谱机器人节点显示名「小亦」（后端 `neo4j_client._BOT_DISPLAY`）。星图展示层把自我节点与小亦合成中心「XX与小亦」（`Graph.jsx` `composeDuoCenter`，03 §9），抽取带审核门槛防口误/寒暄愣存（03 §3）。星图交互（2026-09-03 十五轮）：名字常驻细闪小字、中心「XX与小亦」锁死居中不可拖/不可点（raycast 置空）、卫星拖拽松手沿方位弹回原轨道半径（`Graph3D.jsx`）。
- **视觉模式隐私硬约束**（12 §5）：`DesktopAssistant.jsx` 的摄像头仅在视觉模式开启时打开，关闭立即停摄像头并清轮询定时器；开启时摄像头画面作为页面背景（小亦"在外面玩"）。
- **Live2D 自适应**（11 §6，2026-09-03 起）：`VirtualAvatar` 桌面助手用 `fill` 模式——画布 ResizeObserver 跟随容器、`layoutModel()` 用 `getBounds()` 包围盒对齐（高 ~94%、水平居中、中心放 52% 处）；**四态专属动作**：idle/thinking 由模型动作主导（代码不覆盖头身）、listening/speaking `stopAllMotions()` 后代码全驱姿态并补眨眼/呼吸。固定 `size=md/lg/xl` 仅回退。
- **导航双轨 + 星象名**（2026-09-03 起）：桌面（`md+`）顶部 `Navbar`（品牌 + 4 主入口胶囊 + 昵称/设置齿轮/退出）；移动（`<md`）`Navbar` 内极简顶栏（品牌 + 设置齿轮/退出）+ `MobileTabBar` 底部 4 主入口。入口星象名：`/`星语、`/desktop`星伴、`/gallery`拾光、`/graph`星图（四角星图标）；「设置」不入导航区（桌面右侧齿轮、移动顶栏齿轮）。`App.jsx` `AppLayout` flex 布局，退出入口仅存于导航层（Settings 无退出按钮）。
- **桌面助手实时监听 = Silero VAD**（08 §3，2026-09-03 起）：`DesktopAssistant.jsx` 用 `@ricky0123/vad-web`（浏览器本地 ONNX 推理）判"是不是人声"替代旧振幅阈值，嘈杂环境不误触发/不死锁；**纯自动实时监听、无按住说话**（符合"吧唧"全天候监听设计）。模型/worklet/wasm 由 `npm postinstall`（`frontend/scripts/copy-vad-assets.mjs`）拷入 `public/vad2/` 本地加载，不依赖任何 CDN（目录带版本号，换版本绕开浏览器旧 MIME 缓存，08 §3）。
- **语音触发词**（12 §3.2）：桌面助手转写含「快看快看 / 你看 / 看这个」且视觉模式开启时，截帧 + 走聊天链路回复；视觉模式关闭时触发词按普通对话发送。

## 与 XIAONA 的差异（剥离项）

- 已删除：`backend/app/core/agent/`（执行者/审核者/任务工具）、`api/agent.py`、`api/feishu.py`、`feishu_client.py`、`feishu_session_map.py`、`artifact_cleaner.py`、`cli/`。
- 已删除的模型/表：`AgentTask`、`AgentRunLog`、`FeishuUserMap`、`FeishuSessionMap`、`DataSourceConfig`。
- 模型只剩三槽位且已 **env 写死**（chat / extract / embedding，见 `01 §4`）：不再有设置页模型库 / 功能分配界面，也不接云端 API。
- 不再有 `task_started` SSE 帧、产物下载、飞书绑定、数据源 API key 配置。
