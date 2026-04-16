FROM node:20-alpine

WORKDIR /app

# Install build tools for native modules (better-sqlite3 needs them)
RUN apk add --no-cache python3 make g++ sqlite git

# Copy package files and install deps
COPY package.json .
RUN npm install --omit=dev

# Copy app source
COPY index.js .
COPY public/ ./public/

# Data volume will be mounted at /data (auth_info + messages.db)
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "index.js"]
