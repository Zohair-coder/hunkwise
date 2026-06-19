FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S hunkwise && adduser -S -G hunkwise hunkwise
COPY --from=build --chown=hunkwise:hunkwise /app/package.json /app/package-lock.json ./
COPY --from=build --chown=hunkwise:hunkwise /app/node_modules ./node_modules
COPY --from=build --chown=hunkwise:hunkwise /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=hunkwise:hunkwise /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=hunkwise:hunkwise /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=hunkwise:hunkwise /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=hunkwise:hunkwise /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=hunkwise:hunkwise /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=hunkwise:hunkwise /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=hunkwise:hunkwise /app/packages/db/migrations ./packages/db/migrations
USER hunkwise
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

