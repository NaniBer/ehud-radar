# Build stage: compiles TypeScript and prunes to production dependencies.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w @ehud-radar/api \
  && npm prune --omit=dev \
  && mkdir -p dist

# Runtime stage: smallest surface, non-root user, compiled output only.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
  && chown node:node /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
USER node
EXPOSE 3002
CMD ["node", "dist/index.js"]