# Build frontend and backend
FROM node:20-alpine AS builder
WORKDIR /app

# Copy root package files for workspace setup
COPY package.json package-lock.json ./

# Copy workspace package files
COPY frontend/package*.json ./frontend/
COPY backend/package*.json ./backend/

# Install all dependencies (workspace-aware)
RUN npm ci --legacy-peer-deps

# Copy source files
COPY frontend/ ./frontend/
COPY backend/ ./backend/

# Accept commit SHA as build argument
ARG COMMIT_SHA
ENV COMMIT_SHA=${COMMIT_SHA}

# Frontend build-time env. Omit or set to selfhosted → single-page app at / (no landing).
# Set VITE_SLUGBASE_MODE=cloud for landing/pricing/contact at / and app at /app.
# Published image (CI) is built with selfhosted so GHCR image is the combined selfhosted bundle.
ARG VITE_SLUGBASE_MODE=selfhosted
ARG VITE_API_URL=
ENV VITE_SLUGBASE_MODE=${VITE_SLUGBASE_MODE}
ENV VITE_API_URL=${VITE_API_URL}

# Build both workspaces
RUN npm run build --workspace=frontend
RUN npm run build --workspace=backend

# Copy schema.sql into dist/db so it's included in the dist directory
RUN cp /app/backend/src/db/schema.sql /app/backend/dist/db/schema.sql

# Production image
FROM node:20-alpine
WORKDIR /app

# Accept commit SHA as build argument and set as environment variable
ARG COMMIT_SHA
ENV COMMIT_SHA=${COMMIT_SHA}

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy root package files for workspace setup
COPY package.json package-lock.json ./

# Copy backend package files
COPY backend/package*.json ./backend/

# Install production dependencies for backend workspace only
WORKDIR /app
RUN npm ci --production --legacy-peer-deps --workspace=backend

# Copy built files (schema.sql is already included in dist from builder stage)
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./public

# Set working directory to backend for runtime
WORKDIR /app/backend

# Create data directory for SQLite with proper permissions
RUN mkdir -p /app/data && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000
ENV DB_TYPE=sqlite
ENV DB_PATH=/app/data/slugbase.db

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "dist/index.js"]
