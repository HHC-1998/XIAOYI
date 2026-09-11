#!/usr/bin/env python3
"""XIAOYI 一键启动（跨平台统一入口，替代原 start.bat / start.sh）。

用法：
    python start.py            # 默认：构建镜像 + 启动 5 服务
    python start.py --no-build # 跳过构建，仅启动已有镜像（代码未变时更快）
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser(description="XIAOYI 一键启动")
    parser.add_argument("--no-build", action="store_true",
                        help="跳过 docker build，仅 up（镜像已存在时启动更快）")
    args = parser.parse_args()

    if not (ROOT / ".env").exists():
        print("未找到 .env，请先执行：cp .env.example .env 并填写密钥")
        return 1
    if not shutil.which("docker"):
        print("未检测到 docker，请先安装 Docker 并确保 docker 在 PATH 中")
        return 1
    print("Starting XIAOYI...")
    # --env-file 显式指定根目录 .env：Compose 默认从 compose 文件所在目录（backend/）
    # 查找 .env，会把根目录的 DB/Neo4j/OpenAI 凭据全部丢掉（DB_PASSWORD 等恰与默认值
    # 相同才未暴露，非默认值必须显式传入）
    cmd = ["docker", "compose", "--env-file", str(ROOT / ".env"),
           "-f", str(ROOT / "backend" / "docker-compose.yml"),
           "up"]
    if not args.no_build:
        cmd.append("--build")
    try:
        return subprocess.call(cmd, cwd=str(ROOT))
    except KeyboardInterrupt:
        print("\n已停止 XIAOYI")
        return 0


if __name__ == "__main__":
    sys.exit(main())
