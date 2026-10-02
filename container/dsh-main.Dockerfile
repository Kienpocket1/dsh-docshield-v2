# The one shared DeepSeek Harness (Linux). Agent tools never run here: they
# run in per-user tool containers (tools.Dockerfile) through exec-router.
#   node container/prepare.mjs   (and `npm run build` in docshield/), then from the repo root:
#   docker build -f container/dsh-main.Dockerfile -t docshield-dsh-main:dev .
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.6-alpha.2
ENV NODE_ENV=production npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

WORKDIR /opt/dsh
RUN npm init -y >/dev/null && npm install --omit=dev "@deepseek-ai/dsh@${DSH_VERSION}" && npm cache clean --force
# DSH's SSH execution packages are not published for this version: built lib/ from the DSH source.
COPY container/build/ssh-pkgs/ /opt/dsh/node_modules/@deepseek-ai/

# Plugins. DocShield gets its own (Linux) dependencies; gate has none; exec-router uses DSH's.
WORKDIR /opt/plugins/dsh-docshield
COPY docshield/package.json docshield/cordis.yml ./
RUN npm install --omit=dev && npm cache clean --force
COPY docshield/dist ./dist
COPY docshield/presets ./presets
COPY container/make-harness-presets.mjs /tmp/
RUN node /tmp/make-harness-presets.mjs /opt/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard ./presets && rm /tmp/make-harness-presets.mjs
COPY gate/ /opt/plugins/dsh-gate/
RUN rm -rf /opt/plugins/dsh-gate/var /opt/plugins/dsh-gate/var-test /opt/plugins/dsh-gate/test
COPY exec-router/ /opt/plugins/dsh-exec-router/
RUN ln -s /opt/dsh/node_modules /opt/plugins/dsh-exec-router/node_modules

COPY container/runtime.patch.yml /opt/runtime.patch.yml
COPY container/dsh-main-start.mjs /opt/dsh-main-start.mjs
RUN mkdir -p /home/dsh /data /var/docshield /var/gate && chown node:node /home/dsh /data /var/docshield /var/gate

ENV DSH_HOME=/home/dsh
USER node
EXPOSE 3444
CMD ["node", "/opt/dsh-main-start.mjs"]
