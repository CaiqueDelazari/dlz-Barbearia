FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
ARG NEXT_PUBLIC_APP_URL=https://dlzbarbearia.com.br
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL APP_URL=$NEXT_PUBLIC_APP_URL NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    JWT_SECRET=build-only-jwt-secret-with-more-than-32-characters \
    CRON_SECRET=build-only-cron-secret-with-more-than-32-characters \
    WHATSAPP_ENABLED=false
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["npm","start"]
