# Build context is the repository root.
FROM node:24-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1
ENV CONFIG_DIR=/app/config
WORKDIR /app
COPY config ./config
COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
WORKDIR /app/apps/web
RUN npm ci --no-audit --no-fund
COPY apps/web ./
RUN npm run build && chown -R node:node /app
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "start"]
