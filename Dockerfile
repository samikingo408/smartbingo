# Use Node.js 20
FROM node:20-slim

WORKDIR /app

# Install system dependencies for native node modules (like sqlite3, pg)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
RUN npm install --production

# Copy all backend code AND the public folder (built frontend)
COPY . .

# Set permissions for Hugging Face (expects user 1000)
RUN chown -R 1000:1000 /app

# Switch to the non-root user
USER 1000

# Expose the port (Hugging Face expects traffic on 7860 by default)
EXPOSE 7860

# Start the application
CMD ["node", "src/server.js"]
