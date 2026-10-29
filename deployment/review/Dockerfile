# DSH Remote's App Review host (README.md). Whoever pairs gets DSH Web,
# terminal included, so run it only on a machine that holds nothing else.
# x64 only: DSH ships one of its native add-ons (node-addon-require-builtin) for no other Linux.
FROM --platform=linux/amd64 node:24.17.0-bookworm-slim

# Whoever pairs gets a shell in here: take Debian's security fixes since the base image.
RUN apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/*

# DSH, and the pnpm it installs plugins with (11.23 or later: docs/setup.md).
RUN npm install -g @deepseek-ai/dsh@0.2.1-rc.3 pnpm@11.28.8 && npm cache clean --force

WORKDIR /opt/review
RUN npm install --no-audit --no-fund qrcode@1.5.4 && npm cache clean --force
COPY model.mjs start.mjs page.html ./

RUN useradd --create-home --uid 10001 review
USER review
WORKDIR /home/review
ENV DSH_HOME=/home/review/.dsh

# DSH Remote and dsh-mobile-maxxing from a release, checked the way the installer always checks them.
ARG DSHR_VERSION=0.1.6
RUN node -e "fetch('https://github.com/pentaCoxian/dsh-remote/releases/download/v' + process.env.DSHR_VERSION + '/install.mjs').then((r) => { if (!r.ok) throw new Error('install.mjs: ' + r.status); return r.text(); }).then((text) => require('node:fs').writeFileSync('/tmp/install.mjs', text))" \
  && node /tmp/install.mjs "$DSHR_VERSION" \
  && rm /tmp/install.mjs
# One workspace, already DSH's default, so the first message does not ask for a folder.
COPY --chown=review workspace/README.md Documents/deepseek-harness/default-workspace/README.md
COPY --chown=review workspace/workspace.json .dsh/storages/workspace.json

EXPOSE 8080
CMD ["node", "/opt/review/start.mjs"]
