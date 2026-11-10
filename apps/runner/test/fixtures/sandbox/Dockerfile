# Test image for apps/ircd/test/runner/sandbox.integration.test.ts (agent-sandbox task 8.1): the
# Fake_Agent instead of kiro-cli, with the production entrypoint and probe. Built from the repo root:
#   podman build -t localhost/seance-agent-test:build -f apps/runner/test/fixtures/sandbox/Dockerfile .
# The suite builds it only when this base image is already present locally (it never pulls).
# Base pinned by digest (node:26-bookworm-slim, index digest of 2026-11-05).
FROM docker.io/library/node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

RUN apt-get update \
 && apt-get install -y --no-install-recommends netcat-openbsd git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --create-home --home-dir /home/agent --shell /usr/sbin/nologin agent

COPY --chmod=0644 apps/runner/test/fixtures/fake-agent.ts /opt/seance/fake-agent.ts
COPY --chmod=0755 apps/runner/test/fixtures/fake-kiro /opt/seance/fake-kiro
COPY --chmod=0755 sandbox/seance-entry sandbox/seance-probe /usr/local/bin/
RUN ln -s /opt/seance/fake-kiro /usr/local/bin/kiro-cli

USER 10001:10001
ENV HOME=/home/agent
# Same npm settings as sandbox/Dockerfile (agent-sandbox task 21): offline, cache in the tmpfs $HOME.
# Node 25+ images no longer bundle the package-manager shim; node, npm and npx are all there is.
ENV NPM_CONFIG_CACHE=/home/agent/.npm \
    NPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/seance-entry"]
