"""Neo4j 封装：节点/边带 user_id，多用户隔离（03 §7）。

所有方法均为同步阻塞调用（走 Neo4j 网络 I/O），调用方用 asyncio.to_thread 包裹。
"""
from datetime import datetime, timezone
from typing import Any
import logging
import re

from app.config import NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, KG_MERGE_THRESHOLD

logger = logging.getLogger(__name__)

# 用户自称指代（2026-08-15 起）：抽取/合并时归并到自我节点，避免出现「我/我的」与
# 昵称节点（如 HHC）两个关于用户自己的重复节点。
_SELF_REFS = ("我", "我自己", "本人", "自己", "我的")
# 机器人指代（2026-08-15 起）：抽取/合并时归并到机器人节点（is_bot），避免出现孤立的
# 「你」节点——「你/小亦/XIAOYI」在对话中指的是聊天机器人本身（03 §6 扩展）。
_BOT_REFS = ("你", "小亦", "xiaoyi", "XIAOYI")
_BOT_DISPLAY = "小亦"

# Cypher 关系类型 / 节点标签白名单：LLM 抽取的 pred 与导入数据里的 label/rel_type 会拼进
# Cypher 语句（f-string 插入），须拦截注入载荷。仅允许中文/字母/数字/下划线，≤32 字符。
_REL_TYPE_RE = re.compile(r"^[\u4e00-\u9fffA-Za-z0-9_]{1,32}$")
_LABEL_RE = re.compile(r"^[\u4e00-\u9fffA-Za-z0-9_]{1,32}$")

# 图谱遗忘（03 §9 新增）：新节点初始权重；衰减复用 SQL 的 MEMORY_LAMBDA（按天），
# 低于 ARCHIVE_THRESHOLD 的孤立 Thing 节点被清理。is_self / is_bot 不参与衰减。
_KG_INIT_WEIGHT = 0.5
_KG_BOOST_DELTA = 0.1  # 每次提及命中权重增量（提及增强，封顶见衰减清理）
_KG_ARCHIVE_THRESHOLD = 0.25
_KG_DECAY_MAX_DELETE = 100  # 单轮最多清理节点数，防抖动


class Neo4jClient:
    def __init__(self):
        self._driver = None

    @staticmethod
    def _now_iso() -> str:
        """ISO 时间戳：节点 last_mentioned_at 用（UTC，图谱遗忘衰减依据）。"""
        return datetime.now(timezone.utc).isoformat()

    @property
    def driver(self):
        """惰性创建 driver：首次访问才连接（外部服务未就绪时应用仍可启动）。"""
        if self._driver is None:
            from neo4j import GraphDatabase
            self._driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        return self._driver

    def run(self, query: str, **params):
        with self.driver.session() as s:
            return list(s.run(query, **params))

    # ---------- 幂等 merge 族（03 §6）：按 user_id + name 命中即返回现有节点 id ----------
    def merge_person(self, name: str, user_id: str) -> str:
        """按 user_id+name 幂等取/建 Person 节点（03 §6）。

        2026-09-03 跨标签去重：若已存在同名 Thing（历史误抽），升级为 Person 复用，
        不另建第二个同名节点（用户"妈"被存成 Person+Thing 两个的根因之一）。
        """
        hit = self.run(
            "MATCH (p:Person {user_id: $user_id, name: $name}) RETURN elementId(p) AS id LIMIT 1",
            user_id=user_id, name=name,
        )
        if hit:
            return hit[0]["id"]
        # 同名 Thing 存在 → 升级为 Person（REMOVE :Thing SET :Person，属性保留）
        thing = self.run(
            "MATCH (t:Thing {user_id: $user_id, name: $name}) RETURN elementId(t) AS id LIMIT 1",
            user_id=user_id, name=name,
        )
        if thing:
            self.run(
                "MATCH (t:Thing {user_id: $user_id, name: $name}) REMOVE t:Thing SET t:Person",
                user_id=user_id, name=name,
            )
            return thing[0]["id"]
        rec = self.run(
            "MERGE (p:Person {user_id: $user_id, name: $name}) "
            "ON CREATE SET p.aliases = [$name], p.weight = $weight, p.last_mentioned_at = $now "
            "RETURN elementId(p) AS id",
            user_id=user_id, name=name,
            weight=_KG_INIT_WEIGHT, now=self._now_iso(),
        )
        return rec[0]["id"]

    def ensure_self_node(self, user_id: str, name: str) -> str:
        """用户自我节点：注册即建、按 user_id 幂等（03 §新增）。

        每个用户至多一个 is_self 节点（MERGE 键含 is_self=true，普通实体 Person 不受影响）。
        名称 = 昵称（未设置昵称时由调用方传"用户+手机号"），改名后下次调用自动更新。
        注意：ON MATCH 会覆盖名称为传入 name，因此"仅获取不覆盖名称"请用 get_self_node_id。
        """
        q = (
            "MERGE (p:Person {user_id: $user_id, is_self: true}) "
            "ON CREATE SET p.name = $name, p.aliases = [$name], "
            "             p.weight = $weight, p.last_mentioned_at = $now "
            "ON MATCH SET p.name = $name "
            "RETURN elementId(p) AS id"
        )
        return self.run(q, user_id=user_id, name=name,
                        weight=_KG_INIT_WEIGHT, now=self._now_iso())[0]["id"]

    def get_self_node_id(self, user_id: str) -> str | None:
        """返回自我节点 id（不存在返回 None，不改变节点名称）。"""
        rec = self.run(
            "MATCH (p:Person {user_id: $user_id, is_self: true}) RETURN elementId(p) AS id",
            user_id=user_id,
        )
        return rec[0]["id"] if rec else None

    def get_or_create_self_node(self, user_id: str) -> str:
        """返回自我节点 id；不存在则以「我」兜底创建（不会覆盖已有昵称名）。"""
        sid = self.get_self_node_id(user_id)
        if sid:
            return sid
        return self.ensure_self_node(user_id, "我")

    def ensure_bot_node(self, user_id: str) -> str:
        """机器人节点：每个用户至多一个 is_bot 节点（03 §6 扩展）。

        对话中「你/小亦/XIAOYI」指代聊天机器人，抽取/合并时归并到该节点，
        避免图谱出现孤立的「你」节点。按 user_id 幂等。
        """
        q = (
            "MERGE (b:Person {user_id: $user_id, is_bot: true}) "
            "ON CREATE SET b.name = $name, b.aliases = [$name], "
            "             b.weight = $weight, b.last_mentioned_at = $now "
            "RETURN elementId(b) AS id"
        )
        return self.run(q, user_id=user_id, name=_BOT_DISPLAY,
                        weight=_KG_INIT_WEIGHT, now=self._now_iso())[0]["id"]

    def get_bot_node_id(self, user_id: str) -> str | None:
        """返回机器人节点 id（不存在返回 None，不创建）。"""
        rec = self.run(
            "MATCH (b:Person {user_id: $user_id, is_bot: true}) RETURN elementId(b) AS id",
            user_id=user_id,
        )
        return rec[0]["id"] if rec else None

    def resolve_self_ref(self, name: str, user_id: str) -> str | None:
        """自称/昵称指代 → 自我节点 id（无则先建）；非指代返回 None。

        两种情形归并到自我节点：
        1. 名称为自称词（我/我的/本人等）；
        2. 名称与自我节点当前昵称相同（抽取可能把昵称如 HHC 当普通实体建过节点）。
        """
        if name in _SELF_REFS:
            return self.get_or_create_self_node(user_id)
        sid = self.get_self_node_id(user_id)
        if sid:
            rec = self.run(
                "MATCH (p) WHERE elementId(p) = $id RETURN p.name AS name", id=sid,
            )
            if rec and rec[0]["name"] == name:
                return sid
        return None

    def resolve_bot_ref(self, name: str, user_id: str) -> str | None:
        """机器人指代（你/小亦/XIAOYI）→ 机器人节点 id（无则先建）；非指代返回 None。"""
        if name in _BOT_REFS:
            return self.ensure_bot_node(user_id)
        bid = self.get_bot_node_id(user_id)
        if bid:
            rec = self.run(
                "MATCH (b) WHERE elementId(b) = $id RETURN b.name AS name", id=bid,
            )
            if rec and rec[0]["name"] == name:
                return bid
        return None

    def merge_entity(self, name: str, kind: str, user_id: str) -> str:
        """合并实体到图谱：自称归并自我节点，机器人指代归并机器人节点，否则按 Person/Thing 建节点。

        kind 仅区分 Person / Thing（与 merge_person / merge_thing 语义一致）。
        """
        sid = self.resolve_self_ref(name, user_id)
        if sid:
            return sid
        bid = self.resolve_bot_ref(name, user_id)
        if bid:
            return bid
        if kind == "Person":
            return self.merge_person(name, user_id)
        return self.merge_thing(name, user_id)

    def consolidate_self_refs(self, user_id: str) -> None:
        """清理历史重复的自我指代节点（登录/打开图谱时兜底执行一次）。

        早期抽取可能把「我/我的/本人」等抽成独立节点，与自我节点重复（用户在图谱看到
        两个"自己"）。把这类节点的全部关系转移到自我节点后删除该节点，幂等、失败不阻断。
        """
        sid = self.get_self_node_id(user_id)
        if not sid:
            return
        names = list(_SELF_REFS)
        self_name = self.run(
            "MATCH (p:Person {user_id: $user_id, is_self: true}) RETURN p.name AS name",
            user_id=user_id,
        )
        if self_name and self_name[0]["name"]:
            names.append(self_name[0]["name"])
        cand = self.run(
            "MATCH (n {user_id: $user_id}) WHERE elementId(n) <> $sid AND n.name IN $names "
            "RETURN elementId(n) AS id",
            user_id=user_id, sid=sid, names=names,
        )
        for rec in cand:
            cid = rec["id"]
            try:
                # 入边 a -> c 改为 a -> self
                for r in self.run(
                    "MATCH (a {user_id: $user_id})-[r]->(c) "
                    "WHERE c.user_id = $user_id AND elementId(c) = $cid "
                    "RETURN elementId(a) AS a, type(r) AS t",
                    user_id=user_id, cid=cid,
                ):
                    self.link(r["a"], r["t"], sid, user_id)
                # 出边 c -> b 改为 self -> b
                for r in self.run(
                    "MATCH (c)-[r]->(b {user_id: $user_id}) "
                    "WHERE c.user_id = $user_id AND elementId(c) = $cid "
                    "RETURN type(r) AS t, elementId(b) AS b",
                    user_id=user_id, cid=cid,
                ):
                    self.link(sid, r["t"], r["b"], user_id)
                self.run(
                    "MATCH (c {user_id: $user_id}) WHERE elementId(c) = $cid DETACH DELETE c",
                    user_id=user_id, cid=cid,
                )
            except Exception:
                # 单个节点归并失败不阻断整体清理
                continue

    def consolidate_bot_refs(self, user_id: str) -> None:
        """清理历史孤立的机器人指代节点（「你」等），归并到机器人节点后删除。

        早期抽取可能把「你」抽成独立节点，与机器人节点重复（用户在图谱看到一个
        突兀的"你"）。把这类节点的全部关系转移到机器人节点后删除该节点，
        幂等、失败不阻断（打开图谱页兜底执行一次，03 §6 扩展）。
        """
        bid = self.get_bot_node_id(user_id)
        if not bid:
            return
        names = list(_BOT_REFS)
        self_name = self.run(
            "MATCH (b:Person {user_id: $user_id, is_bot: true}) RETURN b.name AS name",
            user_id=user_id,
        )
        if self_name and self_name[0]["name"]:
            names.append(self_name[0]["name"])
        cand = self.run(
            "MATCH (n {user_id: $user_id}) WHERE elementId(n) <> $bid AND n.name IN $names "
            "RETURN elementId(n) AS id",
            user_id=user_id, bid=bid, names=names,
        )
        for rec in cand:
            cid = rec["id"]
            try:
                # 入边 a -> c 改为 a -> bot
                for r in self.run(
                    "MATCH (a {user_id: $user_id})-[r]->(c) "
                    "WHERE c.user_id = $user_id AND elementId(c) = $cid "
                    "RETURN elementId(a) AS a, type(r) AS t",
                    user_id=user_id, cid=cid,
                ):
                    self.link(r["a"], r["t"], bid, user_id)
                # 出边 c -> b 改为 bot -> b
                for r in self.run(
                    "MATCH (c)-[r]->(b {user_id: $user_id}) "
                    "WHERE c.user_id = $user_id AND elementId(c) = $cid "
                    "RETURN type(r) AS t, elementId(b) AS b",
                    user_id=user_id, cid=cid,
                ):
                    self.link(bid, r["t"], r["b"], user_id)
                self.run(
                    "MATCH (c {user_id: $user_id}) WHERE elementId(c) = $cid DETACH DELETE c",
                    user_id=user_id, cid=cid,
                )
            except Exception:
                # 单个节点归并失败不阻断整体清理
                continue

    def consolidate_duplicate_names(self, user_id: str) -> None:
        """清理历史「跨标签同名重复」节点（2026-09-03）。

        早期抽取把同一名字（如口误"妈"）在不同轮次抽成 Person / Thing 各一个节点。
        遍历同 user 下重名节点组：幸存者 = Person 优先（人是实体优先语义，也避免
        Thing 幸存后再被升级）；把重复节点入/出边转移到幸存者（link 幂等自动去重边）
        后 DETACH DELETE。幂等、单点失败不阻断（打开图谱页兜底执行）。
        """
        groups = self.run(
            "MATCH (n {user_id: $user_id}) "
            "WITH n.name AS name, collect(n) AS ns WHERE size(ns) > 1 "
            "RETURN name, [x IN ns | elementId(x)] AS ids, [x IN ns | labels(x)[0]] AS lbls",
            user_id=user_id,
        )
        for g in groups:
            ids, lbls = g["ids"], g["lbls"]
            if len(ids) < 2:
                continue
            # 幸存者：Person 优先，否则第一个
            survivor = next((i for i, l in zip(ids, lbls) if l == "Person"), ids[0])
            for cid in ids:
                if cid == survivor:
                    continue
                try:
                    # 入边 a -> c 改为 a -> survivor
                    for r in self.run(
                        "MATCH (a {user_id: $user_id})-[r]->(c) "
                        "WHERE c.user_id = $user_id AND elementId(c) = $cid "
                        "RETURN elementId(a) AS a, type(r) AS t",
                        user_id=user_id, cid=cid,
                    ):
                        self.link(r["a"], r["t"], survivor, user_id)
                    # 出边 c -> b 改为 survivor -> b
                    for r in self.run(
                        "MATCH (c)-[r]->(b {user_id: $user_id}) "
                        "WHERE c.user_id = $user_id AND elementId(c) = $cid "
                        "RETURN type(r) AS t, elementId(b) AS b",
                        user_id=user_id, cid=cid,
                    ):
                        self.link(survivor, r["t"], r["b"], user_id)
                    self.run(
                        "MATCH (c {user_id: $user_id}) WHERE elementId(c) = $cid DETACH DELETE c",
                        user_id=user_id, cid=cid,
                    )
                except Exception:
                    # 单个重复节点归并失败不阻断整体清理
                    continue

    def merge_thing(self, name: str, user_id: str) -> str:
        """按 user_id+name 幂等取/建 Thing 节点（03 §6）。

        2026-09-03 跨标签去重：若已存在同名 Person（人不应被降级为物），直接返回该 Person id，
        不另建 Thing 重复节点。
        """
        per = self.run(
            "MATCH (p:Person {user_id: $user_id, name: $name}) RETURN elementId(p) AS id LIMIT 1",
            user_id=user_id, name=name,
        )
        if per:
            return per[0]["id"]
        hit = self.run(
            "MATCH (t:Thing {user_id: $user_id, name: $name}) RETURN elementId(t) AS id LIMIT 1",
            user_id=user_id, name=name,
        )
        if hit:
            return hit[0]["id"]
        rec = self.run(
            "MERGE (t:Thing {user_id: $user_id, name: $name}) "
            "ON CREATE SET t.aliases = [$name], t.weight = $weight, t.last_mentioned_at = $now "
            "RETURN elementId(t) AS id",
            user_id=user_id, name=name,
            weight=_KG_INIT_WEIGHT, now=self._now_iso(),
        )
        return rec[0]["id"]

    def link(self, from_id: str, rel_type: str, to_id: str, user_id: str) -> None:
        # 关系类型白名单校验：pred 由 LLM 抽取、会被 f-string 拼进 Cypher 关系类型，
        # 必须拦截注入载荷（如 `x}) DETACH DELETE n //`）。非法类型跳过并记日志。
        if not _REL_TYPE_RE.fullmatch(rel_type or ""):
            logger.warning("skip link with unsafe rel_type=%r", rel_type)
            return
        # 自环防护：from==to（如三元组 sub/obj 都归并到同一自我节点）不建边，
        # 3D 图会渲染成环且无信息量（2026-08-15 回填发现 HHC->HHC 自环）。
        if from_id == to_id:
            return
        self.run(
            f"MATCH (a), (b) WHERE elementId(a) = $from_id AND elementId(b) = $to_id "
            f"AND a.user_id = $user_id AND b.user_id = $user_id "
            f"MERGE (a)-[r:{rel_type} {{user_id: $user_id}}]->(b)",
            from_id=from_id, to_id=to_id, user_id=user_id,
        )

    def delete_or_archive(self, node_id: str, user_id: str) -> None:
        """级联删除节点及其关联边（仅限当前用户，03 §9）。"""
        self.run(
            "MATCH (n) WHERE elementId(n) = $node_id AND n.user_id = $user_id "
            "DETACH DELETE n",
            node_id=node_id, user_id=user_id,
        )

    def delete_or_soft_delete_session_refs(self, user_id: str, session_id: str) -> None:
        """删除会话相关的事件引用（07 §9）。Event 节点带 session_id 属性时删除。"""
        self.run(
            "MATCH (n {user_id: $user_id}) WHERE n.session_id = $session_id DETACH DELETE n",
            user_id=user_id, session_id=session_id,
        )

    # ---------- 检索（03 §8） ----------
    def query_subgraph(self, user_id: str, entity_names: list[str],
                       depth: int = 1, directed: bool = True):
        direction = "->" if directed else "-"
        # 提及增强：命中实体刷新 last_mentioned_at 与 weight（图谱遗忘衰减的反向机制，
        # 常被提到的节点权重回升，不被遗忘清理）
        if entity_names:
            self.run(
                "MATCH (n {user_id: $user_id}) "
                "WHERE n.name IN $names OR any(alias IN COALESCE(n.aliases, []) WHERE alias IN $names) "
                "SET n.last_mentioned_at = $now, "
                "    n.weight = CASE WHEN n.weight IS NULL THEN $weight "
                "                      ELSE n.weight + $boost END",
                user_id=user_id, names=entity_names, now=self._now_iso(),
                weight=_KG_INIT_WEIGHT, boost=_KG_BOOST_DELTA,
            )
        query = """
        MATCH path = (n)-[*1..%d]%s(m)
        WHERE n.user_id = $user_id
          AND m.user_id = $user_id
          AND (n.name IN $names OR any(alias IN COALESCE(n.aliases, []) WHERE alias IN $names))
        RETURN path
        LIMIT 50
        """ % (depth, direction)
        return self.run(query, user_id=user_id, names=entity_names)

    def get_full_graph(self, user_id: str, edge_limit: int = 500) -> dict:
        """全图（03 §9）：LIMIT 作用于返回行，限制的是关系条数。

        2026-08-15：除关系节点对外，另返回所有孤立节点（含注册即建的自我节点），
        保证新用户图谱至少有自我节点一个点。
        """
        query = """
        MATCH (n {user_id: $user_id})-[r]->(m {user_id: $user_id})
        RETURN n, r, m
        LIMIT $edge_limit
        """
        orphan_query = """
        MATCH (n {user_id: $user_id})
        WHERE NOT (n)--()
        RETURN n
        """
        nodes, links = {}, []
        truncated = False
        with self.driver.session() as s:
            for rec in s.run(query, user_id=user_id, edge_limit=edge_limit):
                n, m = rec["n"], rec["m"]
                for x in (n, m):
                    nodes.setdefault(x.element_id, {
                        "id": x.element_id,
                        "name": x.get("name"),
                        "label": list(x.labels)[0] if x.labels else "Unknown",
                        # 白名单导出展示字段，排除 user_id 等内部隔离字段
                        "properties": {k: v for k, v in x.items() if k not in ("user_id",)},
                    })
                links.append({
                    "source": n.element_id,
                    "target": m.element_id,
                    "type": rec["r"].type,
                })
            # LIMIT 命中上限即视为截断：实际关系数可能更多，前端据此提示
            truncated = len(links) >= edge_limit
            # 孤立节点（无任何关系，如刚注册的自我节点）
            for rec in s.run(orphan_query, user_id=user_id):
                x = rec["n"]
                nodes.setdefault(x.element_id, {
                    "id": x.element_id,
                    "name": x.get("name"),
                    "label": list(x.labels)[0] if x.labels else "Unknown",
                    "properties": {k: v for k, v in x.items() if k not in ("user_id",)},
                })
        return {"nodes": list(nodes.values()), "links": links, "truncated": truncated}

    # ---------- 导出 / 导入 / 清空（09） ----------
    def export_all(self, user_id: str) -> dict:
        nodes = self.run(
            "MATCH (n {user_id: $user_id}) RETURN n", user_id=user_id,
        )
        rels = self.run(
            "MATCH (n {user_id: $user_id})-[r]->(m {user_id: $user_id}) "
            "RETURN r, elementId(startNode(r)) AS src, elementId(endNode(r)) AS dst, r.type AS type",
            user_id=user_id,
        )
        return {
            "nodes": [
                {"element_id": r["n"].element_id, "labels": list(r["n"].labels),
                 "props": {k: v for k, v in r["n"].items() if k != "user_id"}}
                for r in nodes
            ],
            "relationships": [
                {"source": r["src"], "target": r["dst"], "type": r["type"]}
                for r in rels
            ],
        }

    def import_graph(self, data: dict, user_id: str) -> None:
        """导入知识图谱（09 §5 备份恢复）。

        **幂等语义（2026-08-24 起）**：备份恢复=整体替换——先 `clear_graph(user_id)`
        再导入，重复导入同一备份不会复制节点。此前用 CREATE 无条件新建，重复导入
        会复制全部节点与关系，且导出 props 含 is_self=true 时会额外生成自我节点、
        违反「每用户至多一个 is_self 节点」不变量（见当天台账）。

        导入节点时剥离 is_self/is_bot 特殊属性——自我/机器人节点由
        ensure_self_node / consolidate_bot_refs 幂等兜底重建，避免复制不变量节点。
        """
        self.clear_graph(user_id)
        node_id_map: dict[str, str] = {}
        for node in data.get("nodes", []):
            props = dict(node.get("props") or {})
            labels = node.get("labels") or ["Thing"]
            label = labels[0]
            # 标签白名单校验：导入的 label 会拼进 Cypher，拦截注入载荷
            if not _LABEL_RE.fullmatch(label or ""):
                logger.warning("skip import node with unsafe label=%r", label)
                continue
            name = props.get("name")
            if not name:
                continue
            # 自我/机器人节点由 ensure_self_node / consolidate_bot_refs 幂等兜底，
            # 导入备份不直接复制（防重复导入产生多个 is_self 节点）
            props.pop("is_self", None)
            props.pop("is_bot", None)
            props["user_id"] = user_id
            created = self.run(
                f"CREATE (n:{label} $props) RETURN elementId(n) AS id", props=props
            )
            node_id_map[node["element_id"]] = created[0]["id"]
        for rel in data.get("relationships", []):
            src, dst = node_id_map.get(rel["source"]), node_id_map.get(rel["target"])
            if src and dst:
                self.link(src, rel["type"], dst, user_id)

    def clear_graph(self, user_id: str) -> None:
        self.run("MATCH (n {user_id: $user_id}) DETACH DELETE n", user_id=user_id)

    # ---------- 图谱遗忘（03 §9 新增） ----------
    def decay_kg(self, user_id: str, days: float = 1.0) -> dict:
        """知识图谱衰减 + 清理（定时遗忘任务调用，forgetter 侧统一调度）。

        1. 所有非 is_self / is_bot 节点 weight 按天衰减（复用 MEMORY_LAMBDA，
           weight *= exp(-MEMORY_LAMBDA * days)），长期不提的实体权重持续下降。
        2. 权重低于 ARCHIVE_THRESHOLD 的孤立 Thing 节点 DETACH DELETE（无 self 连边、
           不再被检索命中的纯记录型节点），单轮最多 _KG_DECAY_MAX_DELETE 条防抖动。
        3. is_self / is_bot 与仍有关系（含指向 self 的「提到」边）的节点不清理。

        返回 {"decayed": n, "deleted": m} 供日志/文档核对。
        """
        import math
        from app.config import MEMORY_LAMBDA

        decay_factor = math.exp(-MEMORY_LAMBDA * days)
        # 衰减：weight 按天指数衰减（旧节点无 weight/last_mentioned_at 时以初始权重兜底）
        self.run(
            "MATCH (n {user_id: $user_id}) "
            "WHERE n.weight IS NOT NULL AND coalesce(n.is_self, false) = false "
            "  AND coalesce(n.is_bot, false) = false "
            "SET n.weight = n.weight * $decay_factor",
            user_id=user_id, decay_factor=decay_factor,
        )
        # 清理：孤立（无任何边，即无 self 连边/提到关系）且低权重的 Thing 节点
        deleted = self.run(
            "MATCH (n:Thing {user_id: $user_id}) "
            "WHERE NOT (n)--() "
            "  AND coalesce(n.weight, $init) < $threshold "
            "WITH n LIMIT $max_delete "
            "DETACH DELETE n "
            "RETURN count(n) AS c",
            user_id=user_id, init=_KG_INIT_WEIGHT, threshold=_KG_ARCHIVE_THRESHOLD,
            max_delete=_KG_DECAY_MAX_DELETE,
        )
        decayed = self.run(
            "MATCH (n {user_id: $user_id}) "
            "WHERE n.weight IS NOT NULL AND coalesce(n.is_self, false) = false "
            "  AND coalesce(n.is_bot, false) = false "
            "RETURN count(n) AS c",
            user_id=user_id,
        )
        return {
            "decayed": decayed[0]["c"] if decayed else 0,
            "deleted": deleted[0]["c"] if deleted else 0,
        }


neo4j_client = Neo4jClient()
