# melodi-server image. Build from the repository root:
#   docker build -f deploy/server.Dockerfile -t melodi-server .
#
# yt-dlp itself is not baked in: the server downloads it into /data/bin on
# first start and keeps it updated (YouTube breaks old versions regularly).
# It needs Python 3 to run, and Deno to solve YouTube's JavaScript challenges.

FROM rust:1.99.1-bookworm AS build
WORKDIR /src
COPY crates/melodi-core crates/melodi-core
COPY crates/melodi-server crates/melodi-server
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/crates/melodi-server/target \
    cd crates/melodi-server \
    && cargo build --release --locked \
    && cp target/release/melodi-server /usr/local/bin/melodi-server

FROM denoland/deno:bin-2.9.7 AS deno

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=build /usr/local/bin/melodi-server /usr/local/bin/melodi-server

RUN useradd --system --create-home --home-dir /data melodi
USER melodi
WORKDIR /data
# Three long-running yt-dlp processes resolve songs (faster than starting
# yt-dlp per song; see crates/melodi-core/src/ytdlp_worker.rs).
ENV MELODI_ADDR=0.0.0.0:8080 \
    MELODI_DATA_DIR=/data \
    MELODI_YTDLP_WORKERS=3
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"

ENTRYPOINT ["/usr/bin/tini", "--", "melodi-server"]
