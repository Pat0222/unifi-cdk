ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_ARCH

# Fluent Bit 5.1.x from its official package repo. armv7 uses the Raspbian
# build, the only 32-bit ARM package Fluent Bit publishes for bookworm.
RUN set -eux; \
    case "${BUILD_ARCH}" in armv7) distro=raspbian ;; *) distro=debian ;; esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL https://packages.fluentbit.io/fluentbit.key \
      | gpg --dearmor -o /usr/share/keyrings/fluentbit.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/fluentbit.gpg] https://packages.fluentbit.io/${distro}/bookworm bookworm main" \
      > /etc/apt/sources.list.d/fluent-bit.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends 'fluent-bit=5.1.*'; \
    apt-get purge -y gnupg; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

COPY rootfs /
RUN chmod a+x /run.sh

CMD ["/run.sh"]
