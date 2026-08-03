FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/coding-agent/package.json ./packages/coding-agent/

RUN npm ci --omit=dev || npm install --omit=dev

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["node", "packages/coding-agent/dist/cli.js", "--mode", "http", "--http-port", "3000"]
