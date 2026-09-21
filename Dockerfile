# Kanzasset hazine çekirdeği: AMR bağlantı katmanı ve hazine ekranları (tek port: 5000).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY apps/kz-server/package.json apps/kz-server/
COPY apps/kz-web/package.json apps/kz-web/
RUN npm ci

COPY . .
RUN npm run build -w @kz/web

ENV NODE_OPTIONS=--no-warnings
ENV PORT=5000
ENV KZ_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 5000

CMD ["npm", "run", "start", "-w", "@kz/server"]
