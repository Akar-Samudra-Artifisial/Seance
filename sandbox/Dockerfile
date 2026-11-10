# Séance agent sandbox image (spec agent-sandbox, design "Image", decisions D20 and D23).
#
# The runner never pulls: build the image on the host, then pin SEANCE_SANDBOX_IMAGE by digest.
#   cp "$(command -v kiro-cli)" sandbox/kiro-cli        # you supply the binary; check its licence terms
#   sha256sum sandbox/kiro-cli                          # compare with the digest Kiro publishes for that version
#   podman build --build-arg KIRO_CLI_SHA256=<that digest> -t localhost/seance-agent:build -f sandbox/Dockerfile sandbox
#   podman image inspect --format '{{.Digest}}' localhost/seance-agent:build
#   export SEANCE_SANDBOX_IMAGE=localhost/seance-agent@<that digest>
#
# Both bases are pinned by digest; deploy/bootstrap.sh pulls every FROM of this file (and of the test
# fixture's Dockerfile) by that digest before it builds with --pull=never. Update them on purpose.

# agent-sandbox task 21 (D23): Node 26 and npm come from the same image the test fixture pins, so
# `npm test` runs in the sandbox. Only the node binary and the npm files (with npx) are copied.
# Node 25+ images no longer bundle the package-manager shim, so there is nothing else to copy.
FROM docker.io/library/node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS node

# debian:bookworm-slim, index digest of 2026-11-05 (the node image above is built on bookworm too, so
# its binary finds the same libc).
FROM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# ca-certificates for HTTPS to Kiro; netcat for seance-probe; git so that `git` inside the sandbox
# fails with "not a repository" instead of "not found" (no git metadata is mounted on purpose, design
# D3: the runner commits the worktree on the host after each turn).
#
# libatomic1: the node binary copied below links libatomic.so.1, which debian:bookworm-slim lacks (the
# node image has it, so a test image built on that base never showed the gap). The node binary's other
# shared libraries are libc, libm, libstdc++ and libgcc_s; libstdc++6 and libgcc-s1 already come with
# bookworm-slim (apt depends on them) and libc6 is its base, so nothing else is added. The
# `node --version` step below fails the build if a library is ever missing again.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates netcat-openbsd git libatomic1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --create-home --home-dir /home/agent --shell /usr/sbin/nologin agent

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN node --version && npm --version

COPY --chmod=0755 kiro-cli /usr/local/bin/kiro-cli
COPY --chmod=0755 seance-entry seance-probe /usr/local/bin/

# The binary comes from the build context, so state what it must be: the build fails without the
# digest (pass it with --build-arg) or when the file does not match it. Then drop every setuid and
# setgid bit, after the last COPY, so nothing copied in can bring one back.
ARG KIRO_CLI_SHA256
RUN test -n "${KIRO_CLI_SHA256}" \
 && echo "${KIRO_CLI_SHA256}  /usr/local/bin/kiro-cli" | sha256sum -c - \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

USER 10001:10001
ENV HOME=/home/agent
# npm works offline for a project without dependencies: the cache and logs live in the tmpfs $HOME,
# and npm never asks the registry (the egress allow-list would block it anyway).
ENV NPM_CONFIG_CACHE=/home/agent/.npm \
    NPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/seance-entry"]
