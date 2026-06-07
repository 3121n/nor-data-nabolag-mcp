# Build + serve @drist/nabolag-mcp as an Apify Standby MCP Actor.
# Base image follows Apify's Node Actor template.
# https://docs.apify.com/sdk/js/docs/guides/docker-images
FROM apify/actor-node:20 AS builder

# Copy manifests first for Docker layer caching.
COPY package*.json ./

# Install all deps (incl. dev: typescript, tsx) plus the Apify SDK needed only
# by the standby entrypoint. --no-save keeps package.json untouched (the npm
# package itself does not depend on apify).
RUN npm install --include=dev --audit=false \
    && npm install --no-save --audit=false apify

# Copy sources and build dist/.
COPY . ./
RUN npm run build

# ---- Runtime image ----
FROM apify/actor-node:20

COPY package*.json ./

# Production deps for the stdio server (@modelcontextprotocol/sdk, zod) + apify
# for the standby bridge.
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && npm install --no-save --omit=optional --audit=false apify \
    && (npm list --omit=dev --all || true) \
    && node --version \
    && rm -rf ~/.npm

# Built stdio server + the standby HTTP bridge.
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/.actor/standby.mjs ./.actor/standby.mjs

# Standby Actors are reached over HTTP; the bridge spawns dist/index.js (stdio)
# per session and proxies it to a Streamable HTTP MCP endpoint at /mcp.
CMD ["node", "./.actor/standby.mjs"]
