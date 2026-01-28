# Use Node.js LTS
FROM node:18-alpine

# Install pnpm and PM2 globally
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.shims" SHELL="$(which sh)" sh - && \
    npm install -g pm2
ENV PATH="/root/.local/share/pnpm:${PATH}"

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --prod

# Copy application files
COPY . .

# Expose the app port
EXPOSE 5000

# Start the application using PM2
CMD ["pm2-runtime", "start", "ecosystem.config.js"]