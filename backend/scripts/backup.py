"""全库快照脚本（09 §7）。

- PostgreSQL：pg_dump 一致性导出（docker compose exec 用 compose 服务名 postgres）。
- Neo4j：community 版要求离线 dump，编排 stop → 临时容器 dump → start。
- Chroma：维护窗口停库后复制数据卷（保证一致性）。
"""
import subprocess
from datetime import datetime
from pathlib import Path

# 用脚本自身位置定位仓库根，不依赖「从仓库根目录运行」的前提
REPO_ROOT = Path(__file__).resolve().parents[2]
BACKUP_DIR = REPO_ROOT / "backups"
COMPOSE_FILE = str(REPO_ROOT / "backend" / "docker-compose.yml")


def run(cmd: list[str], **kwargs):
    subprocess.run(cmd, check=True, **kwargs)


def snapshot():
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"xiaoyi_{ts}"
    dest.mkdir(parents=True, exist_ok=True)

    # 1) PostgreSQL：pg_dump 一致性导出
    run([
        "docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "postgres",
        "pg_dump", "-U", "xiaoyi", "-d", "xiaoyi", "-F", "c", "-f", "/tmp/xiaoyi.dump",
    ])
    run(["docker", "cp", "xiaoyi_postgres:/tmp/xiaoyi.dump", dest / "postgres.dump"])

    # 2) Neo4j：neo4j-admin database dump（community 版要求数据库离线）
    run(["docker", "compose", "-f", COMPOSE_FILE, "stop", "neo4j"])
    try:
        run([
            "docker", "run", "--rm",
            "-v", "xiaoyi_neo4j_data:/data",
            "-v", "xiaoyi_neo4j_dumps:/backups",
            "neo4j:5-community",
            "neo4j-admin", "database", "dump", "neo4j", "--to-path=/backups", "--verbose",
        ])
        # 从 dumps 卷拷出
        run([
            "docker", "run", "--rm",
            "-v", "xiaoyi_neo4j_dumps:/src:ro",
            "-v", f"{dest.absolute()}:/dst",
            "alpine", "cp", "-a", "/src/.", "/dst/neo4j",
        ])
    finally:
        # 无论 dump 是否成功，都恢复服务
        run(["docker", "compose", "-f", COMPOSE_FILE, "start", "neo4j"])

    # 3) Chroma：维护窗口停库后复制数据卷（保证一致性）
    run(["docker", "compose", "-f", COMPOSE_FILE, "stop", "chroma"])
    try:
        run(["docker", "run", "--rm",
             "-v", "xiaoyi_chroma_data:/src:ro",
             "-v", f"{dest.absolute()}:/dst",
             "alpine", "cp", "-a", "/src/.", "/dst/chroma"])
    finally:
        # 无论复制是否成功，都恢复服务
        run(["docker", "compose", "-f", COMPOSE_FILE, "start", "chroma"])

    print(f"Backup saved to {dest}")


if __name__ == "__main__":
    snapshot()
