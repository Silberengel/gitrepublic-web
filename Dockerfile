# Dockerfile for gitrepublic-web
# Builds a Node.js application with SvelteKit

FROM node:20-alpine AS builder

# Install git and required utilities
# - git: for git operations and git-http-backend
# - zip: for creating ZIP archives (download endpoint)
# - util-linux: for whereis command (used to find git-http-backend)
RUN apk add --no-cache git zip util-linux

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

# Install git and required utilities
# - git: for git operations and git-http-backend
# - zip: for creating ZIP archives (download endpoint)
# - util-linux: for whereis command (used to find git-http-backend)
RUN apk add --no-cache git zip util-linux

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built application from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./

# Create directory for git repositories
RUN mkdir -p /repos && chmod 755 /repos

# Create directory for audit logs (optional, if AUDIT_LOG_FILE is set)
RUN mkdir -p /app/logs && chmod 755 /app/logs

# Create dedicated non-root user for gitrepublic
# Using a dedicated user (not generic 'nodejs') is better security practice
RUN addgroup -g 1001 -S gitrepublic && \
    adduser -S gitrepublic -u 1001 -G gitrepublic && \
    chown -R gitrepublic:gitrepublic /app /repos /app/logs

# Switch to non-root user
USER gitrepublic

# Expose port
EXPOSE 6543

# Set environment variables with defaults
ENV NODE_ENV=production
ENV GIT_REPO_ROOT=/repos
ENV GIT_DOMAIN=localhost:6543
ENV PORT=6543

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:6543', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => {process.exit(1)})"

# Start the application
CMD ["node", "build"]
