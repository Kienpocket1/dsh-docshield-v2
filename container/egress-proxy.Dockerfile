# Egress proxy: the only way out to the internet for tool containers. Node and one file, nothing else.
#   docker build -f container/egress-proxy.Dockerfile -t docshield-egress-proxy:dev .
FROM node:24-bookworm-slim

WORKDIR /opt/proxy
COPY container/egress-proxy.mjs ./
# Marker file: Docker copies this ownership into the empty <prefix>-egress-log volume on first mount.
RUN mkdir -p /var/egress && touch /var/egress/.keep && chown -R 1000:1000 /var/egress
USER 1000:1000
EXPOSE 3128
ENTRYPOINT ["node", "/opt/proxy/egress-proxy.mjs"]
