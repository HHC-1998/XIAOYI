FROM python:3.11-slim

WORKDIR /app

# 国内网络从官方 PyPI 拉包常超时，默认走清华镜像源；
# 海外用户构建时可用 --build-arg PIP_INDEX_URL=... 覆盖
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_INDEX_URL=$PIP_INDEX_URL

# ffmpeg 为系统级依赖（04 §5/§8.2）：convert_to_wav 内部用 subprocess.run(["ffmpeg", ...])，
# 缺装时网页语音转写会抛 FileNotFoundError
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 预下载本地模型进镜像（构建时走宿主机 Clash 代理，见 compose build.args 的
# HTTP_PROXY/HTTPS_PROXY）：faster-whisper 语音识别必须预下载（运行时无法访问
# huggingface.co）；sentence-transformers 已随「chroma 改用配置的 embedding 模型」
# 移除（2026-08-23），向量改由设置页分配的模型经 /v1/embeddings 生成。
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=localhost,127.0.0.1
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY=$NO_PROXY
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')" \
    && rm -rf /root/.cache/pip
ENV HTTP_PROXY= HTTPS_PROXY= NO_PROXY=

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
