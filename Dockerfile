# Install pnpm
FROM node:18-alpine AS pnpm-installer
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.shims" SHELL="$(which sh)" sh -

# Development stage
FROM node:18-alpine AS development

# Install pnpm
COPY --from=pnpm-installer /root/.local/share/pnpm/pnpm /bin/pnpm
ENV PATH="/root/.local/share/pnpm:${PATH}"

WORKDIR /app

# Copy package files
COPY package*.json pnpm-lock.yaml* ./

# Install dependencies using pnpm
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Expose the app port
EXPOSE 5000

# Start the app in development mode
CMD ["pnpm", "run", "dev"]

# Production stage
FROM node:18-alpine AS production

# Install pnpm
COPY --from=pnpm-installer /root/.local/share/pnpm/pnpm /bin/pnpm
ENV PATH="/root/.local/share/pnpm:${PATH}"

WORKDIR /app

# Copy package files
COPY package*.json pnpm-lock.yaml* ./

# Install production dependencies
RUN pnpm install --prod --frozen-lockfile

# Copy built files from development stage
COPY --from=development /app/dist ./dist

# Set NODE_ENV to production
ENV NODE_ENV=production

# Start the app in production mode
CMD ["node", "dist/server.js"]
