FROM node:24-trixie-slim AS ffmpeg-build
ARG FFMPEG_VERSION=9.0.1
ARG FFMPEG_SHA256=cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl libdrm-dev libva-dev libvpl-dev nasm pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/ffmpeg
RUN curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o ffmpeg.tar.xz \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf ffmpeg.tar.xz --strip-components=1 \
    && ./configure \
      --prefix=/opt/ffmpeg \
      --disable-autodetect \
      --disable-debug \
      --disable-doc \
      --disable-ffplay \
      --disable-static \
      --enable-libdrm \
      --enable-libvpl \
      --enable-rpath \
      --enable-shared \
      --enable-vaapi \
    && make -j2 \
    && make install \
    && /opt/ffmpeg/bin/ffmpeg -hide_banner -version \
    && /opt/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -q hevc_qsv \
    && /opt/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -q hevc_vaapi

FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-trixie-slim
LABEL org.opencontainers.image.title="Arrse" \
      org.opencontainers.image.description="Intel hardware media optimizer for Sonarr and Radarr" \
      org.opencontainers.image.source="https://github.com/sampotts/arrse"
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates i965-va-driver intel-media-va-driver libdrm2 libmfx-gen1.2 libva-drm2 libva2 libvpl2 vainfo \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /opt/ffmpeg /opt/ffmpeg
RUN ln -s /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg \
    && ln -s /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe
ENV PATH="/opt/ffmpeg/bin:${PATH}" \
    LD_LIBRARY_PATH="/opt/ffmpeg/lib"
WORKDIR /app
COPY --from=build /app/dist/src ./dist/src
RUN ffmpeg -hide_banner -version | grep -q "ffmpeg version 9.0.1"
RUN mkdir -p /config /cache
VOLUME ["/config", "/cache"]
CMD ["node", "dist/src/index.js"]
