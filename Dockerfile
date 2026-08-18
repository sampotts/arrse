FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="Arrse" \
      org.opencontainers.image.description="Intel Quick Sync media optimizer for Sonarr and Radarr" \
      org.opencontainers.image.source="https://github.com/sampotts/arrse"
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg intel-media-va-driver i965-va-driver vainfo ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist/src ./dist/src
RUN mkdir -p /config /cache
VOLUME ["/config", "/cache"]
CMD ["node", "dist/src/index.js"]
