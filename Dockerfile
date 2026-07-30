# Fermata 用 tsx 直接跑 TypeScript 源码，不需要单独的编译产物，所以省掉多阶段
# 构建：一个阶段装依赖、拷源码、跑起来就够了。

FROM node:24-alpine

WORKDIR /app

# 只复制这两个文件先装依赖，能利用 Docker 的层缓存（源码变了不用重新 npm install）。
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY config ./config
COPY src ./src

# 运行期设置（settings.json）默认写在这里，建议用卷挂载这个目录，
# 不然每次重建/重启容器都会丢失已经保存的设置，退回 config/models.yaml 里的默认值。
RUN mkdir -p /app/data

# 不 COPY .env、experiments/、test/：
# - .env 属于密钥，只能通过容器运行时的环境变量/secret 注入，不进镜像；
# - experiments/、test/ 是开发和调优工具，不是线上服务运行时需要的东西。

EXPOSE 8720

CMD ["npx", "tsx", "src/index.ts"]
