# Per-user tool container: only the agent's "hands" (shell, files, search), no DSH.
# The shared DSH reaches it through launcher.mjs on the internal network.
#   node docshield/node_modules/.bin/esbuild … (see container/build-helper.mjs) then, from the repo root:
#   docker build -f container/tools.Dockerfile -t docshield-tools:dev .
FROM node:24-bookworm-slim

ENV NODE_ENV=production npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash coreutils ripgrep python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/tool
# Native part of the helper: Landlock launcher used by the local sandbox provider (prebuilt linux-x64).
RUN npm init -y >/dev/null && npm install --omit=dev @deepseek-ai/node-addon-system@0.1.2 && npm cache clean --force
COPY container/build/helper.bundle.mjs container/launcher.mjs ./
# A bundled DSH module reads its version from "../package.json" next to the bundle.
RUN printf '{"name":"dsh-helper-bundle","version":"0.1.6-alpha.2","type":"module"}\n' > /opt/package.json

# tool-fs-search in the shared DSH spawns ripgrep by DSH's own absolute path; point that path at the system rg.
ARG DSH_RG_PATH=/opt/dsh/node_modules/@vscode/ripgrep/bin/rg
RUN mkdir -p "$(dirname "$DSH_RG_PATH")" && ln -s /usr/bin/rg "$DSH_RG_PATH"

# Writable places under a read-only rootfs come from tmpfs mounts given at `docker run`.
# Fewer libuv threads per node process: --pids-limit counts threads too.
ENV HOME=/tmp/home HELPER_PATH=/opt/tool/helper.bundle.mjs UV_THREADPOOL_SIZE=2
USER 1000:1000
EXPOSE 7000
ENTRYPOINT ["node", "/opt/tool/launcher.mjs"]
