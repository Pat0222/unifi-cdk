ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_ARCH

# Fluent Bit 5.1.x from its official package repo.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl; \
    curl -fsSL https://packages.fluentbit.io/fluentbit.key \
      | gpg --dearmor -o /usr/share/keyrings/fluentbit.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/fluentbit.gpg] https://packages.fluentbit.io/debian/bookworm bookworm main" \
      > /etc/apt/sources.list.d/fluent-bit.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends 'fluent-bit=5.1.*'; \
    apt-get purge -y gnupg; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# AWS IAM Roles Anywhere credential helper, checked against the SHA256 that
# AWS publishes. AWS ships 64-bit builds only, so there's no armv7 version.
ARG SIGNING_HELPER_VERSION=1.8.5
RUN set -eux; \
    case "${BUILD_ARCH}" in \
      aarch64) arch=Aarch64; sha=3d131aa888cd56da446f9c6bb460b1f0569f6c7edc74eae6193a2fe3928883ba ;; \
      amd64)   arch=X86_64;  sha=beec9ed1c492d93db809890f16713e3556353294b823c2184ad4e891f1b2b54d ;; \
      *) echo "Unsupported architecture: ${BUILD_ARCH}"; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/aws_signing_helper \
      "https://rolesanywhere.amazonaws.com/releases/${SIGNING_HELPER_VERSION}/${arch}/Linux/Amzn2023/aws_signing_helper"; \
    echo "${sha}  /usr/local/bin/aws_signing_helper" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/aws_signing_helper

COPY rootfs /
RUN chmod a+x /run.sh

CMD ["/run.sh"]
