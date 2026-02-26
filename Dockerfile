FROM node:20-slim

WORKDIR /app

# Install dependencies required by sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
  && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first (leverages Docker layer cache)
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# Copy application source
COPY . .

# Create temp-crops directory
RUN mkdir -p temp-crops

EXPOSE 3333

CMD ["node", "server.js"]
