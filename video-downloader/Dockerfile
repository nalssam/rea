# 모아받기 – Node 22 + ffmpeg + yt-dlp
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp는 사이트 변경에 맞춰 자주 갱신됩니다. 특정 버전을 고정하려면
#   docker build --build-arg YTDLP_VERSION=2026.10.26 .
ARG YTDLP_VERSION=
RUN python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir "yt-dlp[default]${YTDLP_VERSION:+==${YTDLP_VERSION}}"

# YouTube의 JS 챌린지는 서버의 Node로 풉니다(YTDLP_JS_RUNTIMES 기본값). yt-dlp[default]에
# 들어 있는 yt-dlp-ejs가 풀이 스크립트를 제공하므로 원격 다운로드는 필요 없습니다.
# 외부로 나가는 yt-dlp 요청은 앱의 송신 보호(EGRESS_GUARD, 기본 켜짐)를 거칩니다. 방어를
# 겹치려면 이 컨테이너를 내부망에 닿지 않는 전용 네트워크에 두세요.
ENV NODE_ENV=production \
    YTDLP_PATH=/opt/ytdlp/bin/yt-dlp \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 3000
# tini가 PID 1로서 종료 신호를 전달하고 고아 프로세스를 정리합니다.
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
