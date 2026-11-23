FROM debian:bookworm-slim
# This operator-built image is resolved to its immutable image ID at launch.
# Runs never install packages or contact a package registry.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 nodejs gcc g++ libc6-dev make rustc cargo golang-go \
    default-jdk-headless ruby perl lua5.4 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["/bin/sh"]
