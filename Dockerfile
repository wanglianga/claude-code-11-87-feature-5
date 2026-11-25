# ---- 构建阶段 ----
FROM node:22-alpine AS build
WORKDIR /app
# 使用国内镜像源（如构建环境无此配置也可通过 --build-arg 覆盖）
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY}
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
# 镜像内只做类型检查与生产构建；单元/冒烟测试可在开发环境执行 npm test
RUN npm run build

# ---- 运行阶段：nginx 托管静态产物 ----
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
