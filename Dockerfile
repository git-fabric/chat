# @git-fabric/chat — multi-stage build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/
RUN npm run build

FROM node:22-alpine

LABEL org.opencontainers.image.title="@git-fabric/chat"
LABEL org.opencontainers.image.description="Chat fabric app — AI conversations with semantic search via Qdrant"
LABEL org.opencontainers.image.source="https://github.com/git-fabric/chat"

RUN addgroup -g 1001 -S fabric && adduser -u 1001 -S fabric -G fabric

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin

USER fabric
ENV NODE_ENV=production

ENTRYPOINT ["node", "bin/cli.js"]
CMD ["start", "--stdio"]
