# The one shared DeepSeek Harness (Linux). Agent tools run in per-user tool
# containers (tools.Dockerfile) through the exec-router plugin.
#   node container/prepare.mjs && docker build -f container/dsh-main.Dockerfile -t docshield-dsh-main:dev .
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.6-alpha.2
ENV NODE_ENV=production npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

WORKDIR /opt/dsh
RUN npm init -y >/dev/null && npm install --omit=dev "@deepseek-ai/dsh@${DSH_VERSION}" && npm cache clean --force
# DSH's SSH execution packages are not published for this version: built lib/ from the DSH source.
COPY container/build/ssh-pkgs/ /opt/dsh/node_modules/@deepseek-ai/

WORKDIR /opt/exec-router
COPY exec-router/ ./
RUN mkdir -p node_modules && ln -s /opt/dsh/node_modules/* node_modules/ 2>/dev/null; \
    ln -sfn /opt/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai

USER node
CMD ["node", "--version"]
