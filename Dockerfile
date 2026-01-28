# Stage 1: Development
FROM node:18-alpine AS development

# Install pnpm
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.shims" SHELL="$(which sh)" sh -
ENV PATH="/root/.local/share/pnpm:${PATH}"

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install

# Copy source code
COPY . .

# Build the app
RUN pnpm run build

# Stage 2: Production
FROM node:18-alpine AS production

# Install pnpm
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.shims" SHELL="$(which sh)" sh -
ENV PATH="/root/.local/share/pnpm:${PATH}"

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies
RUN pnpm install --prod

# Copy built files from development stage
COPY --from=development /app/dist ./dist

# Expose port
EXPOSE 5000

# Start the app
CMD ["node", "dist/index.js"]