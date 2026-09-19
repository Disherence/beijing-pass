# 应用零第三方依赖，因此镜像里只需要 Node 运行时本身
FROM node:20-alpine

WORKDIR /app

# 抓包文件与运行时数据由 .dockerignore 排除，不会进入镜像
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TZ=Asia/Shanghai

# 以非 root 运行；数据目录需要可写，供挂载卷使用
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
