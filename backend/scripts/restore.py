"""全库恢复脚本（09 §7.1）—— 从全库快照恢复，与 backup.py 对称（stop → 操作 → start）。

使用：python backend/scripts/restore.py xiaoyi_20260814_030000
（目录名对应 backups/ 下的快照目录）
"""
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKUP_DIR = REPO_ROOT / "backups"
COMPOSE_FILE = str(REPO_ROOT / "backend" / "docker-compose.yml")


def run(cmd: list[str], **kwargs):
    subprocess.run(cmd, check=True, **kwargs)


def restore(backup_name: str):
    src = BACKUP_DIR / backup_name
    assert src.exists(), f"备份目录不存在：{src}"

    # 1) PostgreSQL：pg_restore 恢复全库（先 drop + recreate，保证从干净状态恢复）
    run(["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "postgres",
         "dropdb", "--if-exists", "-U", "xiaoyi", "xiaoyi"])
    run(["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "postgres",
         "createdb", "-U", "xiaoyi", "xiaoyi"])
    run(["docker", "cp", src / "postgres.dump", "xiaoyi_postgres:/tmp/restore.dump"])
    run(["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "postgres",
         "pg_restore", "-U", "xiaoyi", "-d", "xiaoyi", "--clean", "--if-exists", "/tmp/restore.dump"])

    # 2) Neo4j：community 版要求离线恢复，编排与 backup 对称
    run(["docker", "compose", "-f", COMPOSE_FILE, "stop", "neo4j"])
    try:
        # 只拷 neo4j/ 子目录（含 neo4j.dump）到卷根，--from-path=/backups 才能命中
        run(["docker", "run", "--rm", "-v", "xiaoyi_neo4j_dumps:/backups",
             "-v", f"{src.absolute()}:/src:ro", "alpine", "cp", "-a", "/src/neo4j/.", "/backups/"])
        run(["docker", "run", "--rm",
             "-v", "xiaoyi_neo4j_data:/data",
             "-v", "xiaoyi_neo4j_dumps:/backups",
             "neo4j:5-community",
             "neo4j-admin", "database", "load", "neo4j", "--from-path=/backups", "--overwrite-destination"])
    finally:
        run(["docker", "compose", "-f", COMPOSE_FILE, "start", "neo4j"])

    # 3) Chroma：停库后把备份卷内容复制回 chroma_data 卷再启动
    #    先清空目标卷再复制（cp -a 只覆盖同名文件，不清空会新旧混合损坏）
    run(["docker", "compose", "-f", COMPOSE_FILE, "stop", "chroma"])
    try:
        run(["docker", "run", "--rm",
             "-v", "xiaoyi_chroma_data:/dst",
             "alpine", "sh", "-c", "rm -rf /dst/* /dst/.[!.]* 2>/dev/null || true"])
        run(["docker", "run", "--rm",
             "-v", "xiaoyi_chroma_data:/dst",
             "-v", f"{src.absolute()}:/src:ro",
             "alpine", "cp", "-a", "/src/chroma/.", "/dst/"])
    finally:
        run(["docker", "compose", "-f", COMPOSE_FILE, "start", "chroma"])

    print(f"Restored {backup_name}")


if __name__ == "__main__":
    restore(sys.argv[1] if len(sys.argv) > 1 else "xiaoyi_latest")
