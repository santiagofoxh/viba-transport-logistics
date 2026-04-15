# Optional Dockerfile — Render will auto-detect Node and skip this
# if render.yaml is present. Kept for parity / local Docker runs.
FROM node:20-slim

WORKDIR /app

# System deps for better-sqlite3 native build
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p data

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "server.js"]
