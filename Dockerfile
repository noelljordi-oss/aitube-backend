FROM node:20-slim

WORKDIR /app

# Install Python3 + build tools needed by better-sqlite3 (node-gyp)
RUN apt-get update && \
    apt-get install -y python3 make g++ pkg-config ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
