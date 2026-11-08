# Séance agent sandbox image (spec agent-sandbox, design "Image", decision D20).
#
# The runner never pulls: build the image on the host, then pin SEANCE_SANDBOX_IMAGE by digest.
#   cp "$(command -v kiro-cli)" sandbox/kiro-cli        # you supply the binary; check its licence terms
#   sha256sum sandbox/kiro-cli                          # compare with the digest Kiro publishes for that version
#   podman build --build-arg KIRO_CLI_SHA256=<that digest> -t localhost/seance-agent:build -f sandbox/Dockerfile sandbox
#   podman image inspect --format '{{.Digest}}' localhost/seance-agent:build
#   export SEANCE_SANDBOX_IMAGE=localhost/seance-agent@<that digest>
#
# Base pinned by digest (debian:bookworm-slim, index digest of 2026-11-05). Update it on purpose.
FROM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# ca-certificates for HTTPS to Kiro; netcat for seance-probe; git so that `git` inside the sandbox
# fails with "not a repository" instead of "not found" (no git metadata is mounted, design D3).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates netcat-openbsd git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --create-home --home-dir /home/agent --shell /usr/sbin/nologin agent \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

COPY --chmod=0755 kiro-cli /usr/local/bin/kiro-cli
COPY --chmod=0755 seance-entry seance-probe /usr/local/bin/

# The binary comes from the build context, so state what it must be: the build fails without the
# digest (pass it with --build-arg) or when the file does not match it.
ARG KIRO_CLI_SHA256
RUN test -n "${KIRO_CLI_SHA256}" \
 && echo "${KIRO_CLI_SHA256}  /usr/local/bin/kiro-cli" | sha256sum -c -

USER 10001:10001
ENV HOME=/home/agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/seance-entry"]
