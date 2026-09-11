"""LLM Provider 抽象（01 §7）：OpenAI 兼容协议，可接 OpenAI / Ollama / Claude 网关。

设计说明：
- 统一走 OpenAI 兼容 `/chat/completions` 端点（Ollama 与 Claude 网关均兼容该协议）；
- 全局单例 `llm`：summarize / extract_triples 使用默认抽取模型；
- 聊天（chat / chat_stream）由 memory_engine 从设置页分配解析 model_config 后传入。
"""
import asyncio
import json
import logging
import os
import re

import httpx

from app.config import (OPENAI_API_KEY, XIAOYI_CHAT_MODEL, XIAOYI_EXTRACT_MODEL,
                        XIAOYI_VISION_MODEL, XIAOYI_OLLAMA_BASE_URL)

logger = logging.getLogger(__name__)


def _in_docker() -> bool:
    """后端是否运行在 Docker 容器内（compose 注入 XIAOYI_IN_DOCKER=1，cgroup 检测兜底）。

    用于把用户填的 localhost 自动翻译为宿主机地址（见 _resolve_host）。
    """
    if os.getenv("XIAOYI_IN_DOCKER", "") == "1":
        return True
    try:
        with open("/proc/1/cgroup", "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        return "docker" in content or "kubepods" in content
    except OSError:
        return False


def _resolve_host(base_url: str) -> str:
    """容器内把 localhost/127.0.0.1 自动改写为宿主机别名 host.docker.internal。

    用户在设置页填本地 Ollama 时直接写 http://localhost:11434 即可：后端在容器内会
    自动把 localhost 指向宿主机（Docker Desktop 内置 host.docker.internal，
    Linux 由 compose extra_hosts 映射 host-gateway），无需用户手动改地址。
    """
    if not _in_docker():
        return base_url
    for host in ("localhost", "127.0.0.1", "0.0.0.0"):
        if base_url.startswith(("http://" + host + ":", "https://" + host + ":")):
            return base_url.replace(host, "host.docker.internal", 1)
    return base_url


def _is_local_ollama(base_url: str) -> bool:
    """判断 base_url 是否指向本地 Ollama（keep_alive 等 Ollama 特有参数只对其注入）。

    项目本地模型槽位恒指向 XIAOYI_OLLAMA_BASE_URL（默认 localhost:11434）；容器内
    _ensure_v1/_resolve_host 会把 localhost 改写为 host.docker.internal，一并判定。
    云端 OpenAI/DeepSeek/Claude 网关不识别 keep_alive，传了会 4xx（与 reasoning_effort
    同理，见 _complete）。
    """
    if not base_url:
        return False
    host = _resolve_host(base_url.rstrip("/")).split("//")[-1].split(":")[0].lower()
    return host in ("localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal")


async def _ollama_model_names(base_url: str) -> list[str] | None:
    """探测 Ollama 原生 /api/tags，返回可用模型名列表；服务不可达返回 None。

    供 test_connection 区分「Ollama 服务不可达」与「模型名不存在/不支持对话」，
    避免对本地模型只报笼统的"无法连接"。8s 短超时，探测失败静默返回 None。
    """
    try:
        tags_url = f"{_resolve_host((base_url or '').rstrip('/'))}/api/tags"
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(tags_url)
        if resp.status_code == 200:
            return [m.get("name") for m in resp.json().get("models", [])]
    except Exception:
        logger.warning("ollama /api/tags probe failed", exc_info=True)
    return None


async def _probe_embedding(cfg: dict) -> bool:
    """探测模型是否支持 OpenAI 兼容的 /v1/embeddings（向量化能力）。

    向 {base_url}/v1/embeddings 发最小请求，200 视为支持。8s 短超时，
    网络级失败（ConnectError/Timeout/非 2xx）返回 False，不抛异常。
    """
    base_url = _ensure_v1(cfg.get("base_url") or "")
    if not base_url:
        return False
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    body = {"model": cfg.get("model") or cfg.get("name"), "input": "ping"}
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.post(f"{base_url}/embeddings", headers=headers, json=body)
        return resp.status_code in (200, 201)
    except Exception:
        logger.warning("embedding probe failed: %s", base_url, exc_info=True)
        return False


async def detect_capabilities(cfg: dict) -> dict:
    """探测模型能力：是否支持对话（/v1/chat/completions）与向量化（/v1/embeddings）。

    返回 {"chat": bool, "embedding": bool, "reachable": bool}。
    - reachable=False：两路探测均网络级失败（服务不可达），调用方不应写回能力。
    - 服务可达但模型不支持某能力（如嵌入模型不支持对话）时 reachable=True。
    """
    embedding_ok = await _probe_embedding(cfg)
    chat_ok = False
    try:
        chat_ok, _ = await llm.test_connection(cfg)
    except Exception:
        logger.warning("capability chat probe failed: %s", cfg.get("base_url"), exc_info=True)
    reachable = chat_ok or embedding_ok
    return {"chat": chat_ok, "embedding": embedding_ok, "reachable": reachable}


def _ensure_v1(base_url: str) -> str:
    """补齐 OpenAI 兼容 base_url：容器内 localhost 自动转 host.docker.internal；
    结尾若不是 /v1 则补上（Ollama 的 :11434 → :11434/v1）。"""
    base_url = _resolve_host((base_url or "").rstrip("/"))
    if not base_url:
        return "https://api.openai.com/v1"
    if base_url.endswith("/v1"):
        return base_url
    return f"{base_url}/v1"


def _messages_have_image(messages: list[dict]) -> bool:
    """判断消息中是否含图片多模态 content（用于把模型拒图归类为 VisionNotSupportedError）。"""
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    return True
    return False


class VisionNotSupportedError(RuntimeError):
    """模型拒绝图片输入（HTTP 400/422/415）。聊天引擎据此转成聊天式友好回复（12 §4）。"""


def _raise_model_http_error(e: httpx.HTTPStatusError, messages: list[dict]) -> None:
    """HTTP 4xx/5xx 统一转面向用户的友好错误；带图 4xx 判定为模型不支持视觉。

    把响应体真实 detail 记日志并拼进文案（DeepSeek/OpenAI 错误体不含密钥），
    否则「missing field `type`」这类 400 根因被统一吞成「请检查模型名与 API Key」
    （2026-08-19 台账：任务 ❌ None 排查时发现 tools 格式错误 400 无法定位）。
    """
    if _messages_have_image(messages) and e.response.status_code in (400, 422, 415):
        raise VisionNotSupportedError() from None
    detail = (e.response.text or "").strip()[:300]
    logger.warning("model http %s: %s", e.response.status_code, detail)
    raise RuntimeError(
        f"模型服务返回错误（HTTP {e.response.status_code}）"
        + (f"：{detail}" if detail else "，请检查模型名与 API Key")
    ) from None


class LLMProvider:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=120)

    def _default_config(self, extract: bool = False, vision: bool = False) -> dict:
        # 兜底配置（env 写死本地模型，见 01 §4）：memory_engine 的 _model_configs
        # 已恒返回三槽位配置，此处仅在极少数直连 llm 的场景兜底，同样指向本地 Ollama。
        base_url = _ensure_v1(XIAOYI_OLLAMA_BASE_URL)
        if extract:
            return {
                "model": XIAOYI_EXTRACT_MODEL,
                "base_url": base_url,
                "api_key": OPENAI_API_KEY,
                "temperature": 0.2,
                "max_tokens": 1024,
            }
        if vision:
            # 视觉模型：看图 → 结构化画面描述（12 §2.2 双模型级联的视觉侧）
            return {
                "model": XIAOYI_VISION_MODEL,
                "base_url": base_url,
                "api_key": OPENAI_API_KEY,
                "temperature": 0.1,
                "max_tokens": 1024,
            }
        return {
            "model": XIAOYI_CHAT_MODEL,
            "base_url": base_url,
            "api_key": OPENAI_API_KEY,
            # 兜底 chat 温度：与 memory_engine chat 槽位一致（0.4，2026-09-03 起）
            "temperature": 0.4,
            "max_tokens": 2048,
        }

    async def _complete(self, messages: list[dict], cfg: dict, stream: bool = False,
                        thinking: str = "high", tools: list[dict] | None = None):
        headers = {"Content-Type": "application/json"}
        if cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {cfg['api_key']}"
        body = {
            "model": cfg["model"],
            "messages": messages,
            "temperature": cfg.get("temperature", 0.4),
            "max_tokens": cfg.get("max_tokens", 2048),
            "stream": stream,
        }
        # function calling（02 文档 §5 工具注册表）：tools 为 JSON Schema 数组，
        # 传了则 OpenAI 兼容端点可返回 tool_calls 让执行者循环调用
        if tools:
            body["tools"] = tools
        # DeepSeek V4 思考模式默认 reasoning_effort=high，思考 token 多、首字慢。思考深度按
        # 使用场景分流（memory_engine 按 source 传入 thinking 参数）：语音/桌面助手用 low 快速回话，
        # 文字聊天/CLI/飞书用 high 深度思考（思路更广、准确性更高）。仅对 deepseek 注入：
        # Ollama/OpenAI 等端点不识别该参数，传了会 4xx。
        if "deepseek.com" in (cfg.get("base_url") or ""):
            body["reasoning_effort"] = cfg.get("reasoning_effort", thinking or "high")
        # keep_alive（2026-09-03，语音二轮卡顿根治）：仅本地 Ollama 注入。让 chat/bge-m3
        # 常驻（30m）不再每轮换载、extract/vision 用完即走（30s）；云端端点不识别该参数
        #（与上面 reasoning_effort 同理，只对本地注入）。
        if cfg.get("keep_alive") and _is_local_ollama(cfg.get("base_url")):
            body["keep_alive"] = cfg["keep_alive"]
        url = f"{cfg['base_url']}/chat/completions"
        resp = await self.client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        if not stream:
            data = resp.json()
            msg = data["choices"][0]["message"]
            # 带 tools 调用（function calling）时始终返回完整 message dict（含 tool_calls 或最终 content），
            # 由 chat_with_tools / executor 消费——此前无 tool_calls 时返回 content 字符串，
            # executor 对字符串调 .get("tool_calls") 崩出 'str' object has no attribute 'get'
            #（2026-08-23 台账：任务执行通路全线崩溃根因）。普通聊天（tools=None）仍返回 content 字符串。
            if tools is not None:
                return msg
            return msg.get("content") or ""
        return self._stream_lines(resp, cfg.get("model"))

    async def _stream_lines(self, resp, model=None):
        """流式响应逐行解析，产出 (content_delta, thinking_delta)。

        - content：最终回复增量；
        - thinking：思考过程增量，兼容 DeepSeek `reasoning_content` 与 Ollama `thinking`。
        """
        produced = False
        interrupted = False
        try:
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = chunk["choices"][0].get("delta") or {}
                    content = delta.get("content") or ""
                    thinking = delta.get("reasoning_content") or delta.get("thinking") or ""
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if content or thinking:
                    produced = True
                    yield content, thinking
        except BaseException:
            # 上游中断（打断/取消/超时断流/解析异常冒泡）：非"Ollama 空回"，交由上层探针覆盖
            interrupted = True
            raise
        finally:
            # 探针（2026-09-04，台账 40 节）：流正常耗尽但零产出（HTTP 200 空 choices /
            # 空 delta 的"空回"）。与 memory_engine.chat_stream 的空回复探针呼应，此处带 model
            # 可区分是哪条链路（chat/extract/vision）空回。
            if not produced and not interrupted:
                logger.warning(
                    "llm stream empty (0 delta): model=%s status=%s",
                    model, getattr(resp, "status_code", "?"),
                )

    # ---------- 聊天 ----------
    async def chat(self, messages: list[dict], model_config: dict | None = None, thinking: str = "high") -> str:
        cfg = model_config or self._default_config()
        try:
            return await self._complete(messages, cfg, thinking=thinking)
        except httpx.ConnectError:
            raise ConnectionError("无法连接到模型服务，请检查 Base URL 与网络") from None
        except httpx.TimeoutException:
            raise TimeoutError("模型响应超时，请稍后重试") from None
        except httpx.HTTPStatusError as e:
            _raise_model_http_error(e, messages)

    async def chat_with_tools(self, messages: list[dict], model_config: dict | None = None,
                              tools: list[dict] | None = None, thinking: str = "low") -> dict:
        """function calling 聊天（02 文档 §5/§6 执行者循环）：返回完整 message dict。

        模型可能返回 `tool_calls`（此时 message 含 tool_calls 数组），由执行者循环
        `call_tool` → 结果以 `tool` 角色回填 → 再次调用；也可能直接返回最终
        `content`（无 tool_calls）。错误处理与 chat 一致（友好中文文案）。
        """
        cfg = model_config or self._default_config()
        try:
            return await self._complete(messages, cfg, thinking=thinking, tools=tools)
        except httpx.ConnectError:
            raise ConnectionError("无法连接到模型服务，请检查 Base URL 与网络") from None
        except httpx.TimeoutException:
            raise TimeoutError("模型响应超时，请稍后重试") from None
        except httpx.HTTPStatusError as e:
            _raise_model_http_error(e, messages)

    async def chat_stream(self, messages: list[dict], model_config: dict | None = None, thinking: str = "high"):
        """流式聊天：async generator，产出 (content_delta, thinking_delta) 元组。

        连接/超时/HTTP 错误统一转为面向用户的友好文案，避免原始异常直接上屏。
        thinking：思考深度（deepseek 的 reasoning_effort，desktop=low / 其他=high）。
        """
        cfg = model_config or self._default_config()
        try:
            async for content, thinking in await self._complete(messages, cfg, stream=True, thinking=thinking):
                yield content, thinking
        except httpx.ConnectError:
            raise ConnectionError("无法连接到模型服务，请检查 Base URL 与网络") from None
        except httpx.TimeoutException:
            raise TimeoutError("模型响应超时，请稍后重试") from None
        except httpx.HTTPStatusError as e:
            _raise_model_http_error(e, messages)

    # ---------- 视觉描述（12 §2.2 双模型级联的视觉侧） ----------
    async def describe_image(self, data_url: str, model_config: dict | None = None) -> dict:
        """让视觉模型描述图片，返回结构化判定。

        返回 {description, is_pretty, is_private, worth_speaking, has_text, text_content}：
        - description：中文画面描述（供小亦模型组织口吻化回复，12 §8.2）；
        - is_pretty：画面美观（主动搭话前置条件，12 §4）；
        - is_private：含人物正脸/室内隐私等不应主动搭话的场景；
        - worth_speaking：有"值得一说"的点（风景/文字/有趣画面），排除普通墙面桌面；
        - has_text / text_content：画面含文字时提取（识图/翻译用）。

        失败返回全空兜底（{description: "", ...}），调用方据此静默跳过或提示看不了图，
        不抛异常——视觉是附加能力，不能拖垮聊天主流程。
        """
        cfg = model_config or self._default_config(vision=True)
        prompt = (
            "请仔细观察这张图片，用简洁中文描述画面内容（30~80字），"
            "并给出以下结构化判定。只返回 JSON：\n"
            '{"description": "...", "is_pretty": true/false, "is_private": true/false,'
            ' "worth_speaking": true/false, "has_text": true/false, "text_content": "..."}'
        )
        messages = [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }]
        fallback = {
            "description": "", "is_pretty": False, "is_private": False,
            "worth_speaking": False, "has_text": False, "text_content": "",
        }
        try:
            raw = await self._complete(messages, cfg)
            data = json.loads(self._extract_json(raw))
            out = dict(fallback)
            if data.get("description"):
                out["description"] = str(data["description"]).strip()[:200]
            for k in ("is_pretty", "is_private", "worth_speaking", "has_text"):
                out[k] = bool(data.get(k, False))
            if data.get("text_content"):
                out["text_content"] = str(data["text_content"]).strip()[:500]
            return out
        except Exception as e:
            logger.warning("describe_image failed: %s", e)
            return fallback

    # ---------- 记忆抽取（02 §6 / 03 §4） ----------
    async def summarize(self, text: str, model_config: dict | None = None) -> str:
        """对话摘要（02 §8 遗忘蒸馏）。失败返回 text[:50] 截断。

        model_config：设置页分配的「记忆抽取模型」配置（未配置时用 env 默认抽取模型）。
        此前签名无 model_config，forgetter 调用永远走 env 默认模型——本地 Ollama 用户
        （key 为空）摘摘要恒退化为截断（2026-08-24 审核修复）。
        """
        messages = [
            {"role": "system", "content": "你是记忆助手。请用一句简洁中文概括以下内容（不超过50字）。"},
            {"role": "user", "content": text},
        ]
        try:
            return (await self._complete(messages, model_config or self._default_config(extract=True))).strip()
        except Exception as e:
            logger.warning(f"summarize failed: {e}")
            return text[:50]

    async def extract_triples(self, text: str, model_config: dict | None = None) -> list[tuple[str, str, str, str]]:
        """从对话中提取 (subject, predicate, object, objectKind) 四元组列表。失败时返回空列表。

        objectKind ∈ {"person", "thing"}：宾语是人（含亲属/人称）还是事物，供落库时选 Person/Thing。
        model_config：设置页分配的「记忆抽取模型」配置（未配置时用 env 默认抽取模型）。

        2026-09-03：改为「先审核、后抽取」——寒暄/语气词/口误/无实质内容一律返回空，
        不再把口误（如"在妈"）愣抽成实体；谓词改中文（不再用 KNOWS 特判人/物），
        宾语类型改由 objectKind 显式给出，缺省时按谓词/称谓启发兜底（03 §3）。
        """
        prompt = (
            "第一步：判断下面这段对话是否包含值得长期记住的稳定事实（人物、事物的真实属性、"
            "真实关系、真实事件）。\n"
            "只属于以下情形的，直接返回 []：\n"
            "1. 纯问候/寒暄/语气词，如\"在吗\"\"你好\"\"嗯嗯\"\"哈哈哈\"；\n"
            "2. 口误、错别字或打字错误（如\"在妈\"不是实体\"妈\"）；\n"
            "3. 没有提到任何明确的实体，或内容只是情绪、无实质信息。\n"
            "第二步：如果确实有值得记住的稳定事实，才抽取实体和关系。\n"
            "硬性规则：\n"
            "- 实体必须是原文明确提到的名词（或可明确推断出的人称），禁止编造原文没有的主语；\n"
            "- 单字语气词、无意义单字、称谓碎片（如单独一个\"妈\"而没有上下文）不当作实体；\n"
            "- 谓语用简洁中文动词（如\"认识\"\"喜欢\"\"是\"\"去过\"\"养了\"）；\n"
            "- 抽取的是长期记忆，不是一句话里每个名词都要抽。\n"
            '返回 JSON 数组，每个元素格式：{"subject": "实体A", "predicate": "关系", "object": "实体B", '
            '"objectKind": "person" 或 "thing"}；objectKind 判断宾语是人（人名/亲属称谓/人称）还是物。'
            "没有可抽取内容时返回 []。只返回 JSON，不要解释。\n\n对话：\n" + text
        )
        messages = [
            {"role": "system", "content": "你是实体关系抽取引擎，只抽取稳定事实，拒绝把口误和寒暄当实体。"},
            {"role": "user", "content": prompt},
        ]
        try:
            raw = await self._complete(messages, model_config or self._default_config(extract=True))
            data = json.loads(self._extract_json(raw))
            out = []
            for item in data:
                sub, pred, obj = item.get("subject"), item.get("predicate"), item.get("object")
                if sub and pred and obj:
                    kind = self._judge_object_kind(str(obj), str(pred), item.get("objectKind"))
                    out.append((str(sub).strip(), str(pred).strip(), str(obj).strip(), kind))
            return out
        except Exception as e:
            logger.warning(f"extract_triples failed: {e}")
            return []

    async def extract_entities_from_text(self, query: str, model_config: dict | None = None) -> list[str]:
        """从用户问题中提取实体名列表（02 §7，用于图谱子图检索）。失败返回空列表（不退化整句）。"""
        prompt = (
            "从下面这句话中提取关键实体（人名、地名、事物名），返回 JSON 字符串数组，"
            "最多5个，只返回 JSON：\n" + query
        )
        try:
            raw = await self._complete(messages=[
                {"role": "system", "content": "你是实体抽取引擎，只返回 JSON。"},
                {"role": "user", "content": prompt},
            ], cfg=model_config or self._default_config(extract=True))
            data = json.loads(self._extract_json(raw))
            return [str(x) for x in data if x][:5]
        except Exception as e:
            logger.warning(f"extract_entities failed: {e}")
            return []

    # ---------- 工具 ----------
    # 宾语人/物判定兜底（2026-09-03）：模型 objectKind 缺失/非法时的启发式
    _KIN_TERMS = (
        "爸爸", "妈妈", "妈", "爸", "哥", "姐", "弟", "妹", "爷爷", "奶奶", "姥姥", "姥爷",
        "外婆", "外公", "叔叔", "阿姨", "舅舅", "老师", "同学", "同事", "朋友", "学长", "学姐",
        "学弟", "学妹", "师兄", "师姐", "侄子", "侄女", "外甥", "老婆", "老公", "媳妇", "儿子",
        "女儿", "对象", "亲戚",
    )
    _KIN_PREDS = ("认识", "知道", "喜欢", "爱", "想念", "陪", "陪伴", "照顾", "帮", "和", "跟", "叫")

    @staticmethod
    def _judge_object_kind(obj: str, pred: str, model_kind: str | None) -> str:
        """决定宾语落 Person 还是 Thing：模型显式给出则优先，否则称谓/谓词启发兜底。"""
        if model_kind in ("person", "thing"):
            return model_kind
        if any(t in obj for t in LLMProvider._KIN_TERMS):
            return "person"
        if any(p in pred for p in LLMProvider._KIN_PREDS):
            return "person"
        return "thing"

    @staticmethod
    def _extract_json(raw: str) -> str:
        """从 LLM 输出中提取首个 JSON 块（容错 markdown 代码围栏）。"""
        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```\w*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
        start = raw.find("[")
        if start == -1:
            start = raw.find("{")
        if start == -1:
            raise ValueError("no json found")
        return raw[start:]

    # ---------- 连通性测试（设置页"测试"按钮） ----------
    async def test_connection(self, cfg: dict) -> tuple[bool, str]:
        """向模型端点发最小请求验证连通性。

        返回 (是否连通, 面向用户的说明)。异常与错误详情可能包含端到端信息，
        统一归类为不连通，不向上抛细节（避免泄露 api_key 或内网地址）。
        超时设 60s：本地 Ollama 大模型首次调用需冷启动加载进内存（qwen3:8b
        实测耗时约 10s），8s 短超时会把可用模型误判为"无法连接"。

        Ollama 本地模型（provider == ollama）有针对性诊断：
        - 服务不可达时二次探测 /api/tags，提示确认 Ollama 已启动/监听/防火墙；
        - 模型不存在（ConnectError 后 tags 可达、或 HTTP 404）列出可用模型；
        - 嵌入/向量模型（如 bge-m3）不支持 /v1/chat/completions，明确提示。
        """
        model_name = cfg.get("model") or cfg.get("name")
        is_ollama = (cfg.get("provider") or "").lower() == "ollama"
        headers = {"Content-Type": "application/json"}
        if cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {cfg['api_key']}"
        body = {
            "model": model_name,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        }
        url = f"{_ensure_v1(cfg.get('base_url'))}/chat/completions"
        try:
            # 与默认 120s client 解耦：单独超时，避免全局 client 长时间挂起
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(url, headers=headers, json=body)
        except httpx.TimeoutException:
            logger.warning("test_connection timed out: %s", cfg.get("base_url"), exc_info=True)
            hint = "首次调用需冷启动加载大模型（约 10~60 秒），请稍后重试" if is_ollama else "请稍后重试"
            return False, f"连接超时：{hint}"
        except httpx.ConnectError as exc:
            logger.warning("test_connection connect error: %s", cfg.get("base_url"), exc_info=True)
            # localhost 在容器内已由 _ensure_v1 自动解析为宿主机；仍连不上多是本机服务没启动
            if is_ollama:
                # 二次探测：Ollama 原生 /api/tags，区分「服务不可达」与「模型/协议不匹配」
                names = await _ollama_model_names(cfg.get("base_url"))
                if names is not None:
                    tip = "，可用模型：" + "、".join(names) if names else ""
                    return False, f"Ollama 服务已连通，但模型「{model_name}」不存在，请检查模型名（注意区分 :tag 版本）{tip}"
                return False, (
                    "无法连接本机 Ollama：请确认 Ollama 已启动且监听 11434 端口、防火墙已放行；"
                    "若容器内仍连不上宿主机，可在系统环境变量设 OLLAMA_HOST=0.0.0.0:11434 后重启 Ollama"
                )
            return False, f"无法连接模型服务（{exc.request.url.host}）"
        except Exception:
            logger.warning("test_connection failed to reach %s", cfg.get("base_url"), exc_info=True)
            return False, "无法连接到模型服务"

        if resp.status_code in (200, 201):
            return True, "连接成功"
        # 401/403 等鉴权错误可以提示；其余统一提示失败
        if resp.status_code in (401, 403):
            return False, "鉴权失败，请检查 API Key"
        # Ollama 嵌入/向量模型不支持 chat 接口，给出针对性提示
        if is_ollama:
            if "does not support chat" in resp.text:
                return False, f"模型「{model_name}」不支持对话（它可能是嵌入/向量化模型），请选择对话模型"
            if resp.status_code == 404:
                names = await _ollama_model_names(cfg.get("base_url"))
                tip = "，可用模型：" + "、".join(names) if names else ""
                return False, f"模型「{model_name}」不存在，请检查模型名（注意区分 :tag 版本）{tip}"
        return False, f"模型服务返回错误（HTTP {resp.status_code}）"

    # ---------- 模型列表扫描（设置页"扫描模型"按钮） ----------
    async def list_models(self, cfg: dict) -> tuple[bool, list[str], str]:
        """扫描模型端点返回的可用模型列表。

        - provider == 'ollama'：优先 GET {base_url}/api/tags（Ollama 原生接口），
          失败再试 OpenAI 兼容的 GET {base_url}/models；
        - 其他 provider：GET {_ensure_v1(base_url)}/models，解析 data[].id。
        返回 (是否成功, 模型名列表, 面向用户的说明)。8s 短超时，错误不泄露内部细节。
        """
        base_url = (cfg.get("base_url") or "").rstrip("/")
        headers = {"Content-Type": "application/json"}
        if cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {cfg['api_key']}"

        async def _fetch(url: str) -> list[str]:
            async with httpx.AsyncClient(timeout=8) as client:
                resp = await client.get(url, headers=headers)
            if resp.status_code not in (200, 201):
                return []
            try:
                data = resp.json()
            except Exception:
                return []
            if isinstance(data, list):
                return [str(m.get("id") or m.get("name") or "") for m in data if isinstance(m, dict)]
            if isinstance(data, dict):
                items = data.get("data") or data.get("models") or []
                return [
                    str(m.get("id") or m.get("name") or "")
                    for m in items
                    if isinstance(m, dict) and (m.get("id") or m.get("name"))
                ]
            return []

        try:
            if (cfg.get("provider") or "").lower() == "ollama" and base_url:
                # Ollama 原生 /api/tags：models[].name（含 :tag 后缀，剥离后去重）。
                # localhost 在容器内已自动解析为宿主机（_resolve_host）
                ollama_url = f"{_resolve_host(base_url)}/api/tags"
                async with httpx.AsyncClient(timeout=8) as client:
                    resp = await client.get(ollama_url, headers=headers)
                if resp.status_code in (200, 201):
                    data = resp.json()
                    models = sorted({(m.get("name") or "").split(":")[0] for m in data.get("models", []) if m.get("name")})
                    if models:
                        return True, models, "扫描成功"
            # OpenAI 兼容 /models
            models = await _fetch(f"{_ensure_v1(base_url)}/models")
            if models:
                return True, sorted(set(models)), "扫描成功"
        except Exception:
            logger.warning("list_models failed to reach %s", base_url, exc_info=True)

        return False, [], "无法获取模型列表，请检查地址/密钥"


llm = LLMProvider()
