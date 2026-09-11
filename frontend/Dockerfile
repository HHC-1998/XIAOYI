# ---- 构建阶段：Node 打包静态资源 ----
FROM node:20-alpine AS builder

WORKDIR /app
# 国内网络从官方 npm registry 拉包常超时，默认走 npmmirror；
# 海外用户构建时可用 --build-arg NPM_REGISTRY=... 覆盖
ARG NPM_REGISTRY=https://registry.npmmirror.com
# 目录树只声明 package.json（未提交 package-lock.json），用 package*.json + npm install，
# 避免 COPY package-lock.json 在无 lock 文件时直接失败
COPY package*.json ./
# postinstall 脚本（拷贝 Silero VAD 资产到 public/vad）需要 scripts/ 目录存在
COPY scripts/ ./scripts/
RUN npm install --registry=$NPM_REGISTRY

COPY . .
# 接口走同源 /api 相对路径，由 nginx 反向代理到 backend，无需注入 API 地址
RUN npm run build

# ---- 运行阶段：nginx 托管静态文件 + 反向代理 API ----
FROM nginx:1.25-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
