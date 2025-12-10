# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-slim AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Set production environment
ENV NODE_ENV=production

# Expose port (Railway uses PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the server
CMD ["node", "dist/index.js"]
