# PR review for humans: the web app. Build from the repository root:
#   docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t pr-review-app:dev .
# No secrets in the image: everything secret comes from the environment (a Kubernetes secret).
FROM node:22-alpine AS deps
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY static ./static
COPY seed ./seed
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.js"]
