# 小亦（XIAOYI）· 私人聊天助手

**Personal chat assistant** — 纯聊天 + 三层长期记忆的个人 AI 陪伴。不执行功能任务，不接云端对话 API（模型走本地 Ollama；唯一例外：TTS 用 edge-tts 在线合成）。

> 脱胎于 XIAONA 的聊天链路，剥离了多 Agent / 飞书 / CLI 等执行组件，数据库与容器名全部独立（`xiaoyi_*`）。

## 功能

- **对话**：网页星语 + 桌面星伴（SSE 流式、打字机渲染；思考仅落库）
- **三层记忆**：
  - **PostgreSQL**：会话与消息
  - **ChromaDB**：语义向量检索
  - **Neo4j**：知识图谱（星图可视化）
- **语音**：本地 ASR（faster-whisper / 流式 sherpa）+ **edge-tts**（晓伊 `zh-CN-XiaoyiNeural`）
- **视觉**：桌面助手可选视觉模式（本地视觉模型看图 → 小亦口吻回复）
- **数据管理**：导出 / 导入 / 按层清空

## 技术架构

```
用户 → 网页/桌面助手 → FastAPI ──┬─ PostgreSQL
                                ├─ ChromaDB
                                └─ Neo4j
                     └─ 本地 Ollama（chat / extract / embedding / vision）
```

- 后端：Python 3.11 + FastAPI + SQLAlchemy + SSE
- 前端：React 18 + Vite + Tailwind CSS
- 编排：Docker Compose（见 `backend/docker-compose.yml`）
- 模型槽位（env 写死，见 `AGENTS.md`）：`XIAOYI_CHAT_MODEL` / `XIAOYI_EXTRACT_MODEL` / `XIAOYI_EMBEDDING_MODEL` / `XIAOYI_VISION_MODEL`

## 快速启动

```powershell
Copy-Item .env.example .env
# 按需改 DB 密码、JWT_SECRET、Ollama 模型名等

python start.py
```

- 前端：http://localhost:8080
- 后端文档：http://localhost:8000/docs
- Neo4j：http://localhost:7474

宿主机需已安装并运行 [Ollama](https://ollama.com/)，并拉取/导入对应模型。

## 目录结构

```
XIAOYI/
├── start.py                 # 一键启动
├── .env.example             # 环境变量模板（勿提交真实 .env）
├── AGENTS.md                # 协作约定
├── 项目计划/                 # 模块设计与问题台账
├── backend/                 # FastAPI
│   ├── app/
│   ├── docker-compose.yml
│   └── scripts/
└── frontend/                # React
    └── src/
```

本地可有但不入库：`models/`（ASR 权重）、`训练/`（微调手册与工具链）——见根目录 `.gitignore`。

## 配置说明（.env）

| 变量 | 说明 |
|---|---|
| `DB_PASSWORD` / `NEO4J_PASSWORD` | 数据库密码 |
| `XIAOYI_OLLAMA_BASE_URL` | 本地 Ollama 地址 |
| `XIAOYI_CHAT_MODEL` 等 | 各槽位模型名 |
| `XIAOYI_TTS_VOICE` / `RATE` / `PITCH` | edge-tts 音色与语速音调 |
| `JWT_SECRET` | 生产环境务必改掉默认值 |

## 文档

设计细节与排障见 `项目计划/`；协作硬约定见 `AGENTS.md`（文档反哺：改代码同步改对应模块文档）。
