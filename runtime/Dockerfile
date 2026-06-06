FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    grep \
    jq \
    nodejs \
    npm \
    procps \
    ripgrep \
    sed \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash sandbox \
  && mkdir -p /workspace /tmp/skills \
  && chown -R sandbox:sandbox /workspace /tmp/skills /home/sandbox

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/gtm-openai-local-shell
RUN chmod +x /usr/local/bin/gtm-openai-local-shell

USER sandbox

ENTRYPOINT ["/usr/local/bin/gtm-openai-local-shell"]
CMD ["bash"]
