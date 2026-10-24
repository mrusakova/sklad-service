# Сборка: ставим зависимости (с компилятором на случай, если готового модуля SQLite нет)
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Рабочий образ
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js cli.js ./
COPY public ./public
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
