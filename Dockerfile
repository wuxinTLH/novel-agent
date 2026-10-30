# syntax=docker/dockerfile:1
# Pin this tag to an independently verified digest in your deployment pipeline.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci --ignore-scripts && npm rebuild sharp
COPY tsconfig.json ./
COPY shared ./shared
COPY packages ./packages
COPY scripts ./scripts
COPY public ./public
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/web/package.json ./packages/web/package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data /app/.data-managed-backups && chown node:node /app/data /app/.data-managed-backups
USER node
EXPOSE 3001
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:3001/api/services/user');if(!r.ok)process.exit(1)"]
CMD ["node", "build/packages/server/src/index.js"]
