# Glitter Agent Gate MCP server (stdio). Starts with no env vars or wallet; answers initialize / tools/list.
# Paid tool calls need XRPL_SEED (a dedicated low-balance agent wallet) at run time; without it they return a price quote.
FROM node:20-slim AS build
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY mcp/src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
