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
# - su-exec: for switching users (lightweight alternative to gosu)
RUN apk add --no-cache git zip util-linux su-exec

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built application from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
# Copy docs directory for documentation pages
COPY --from=builder /app/docs ./docs

# Create directory for git repositories
RUN mkdir -p /repos && chmod 755 /repos

# Create directory for audit logs (optional, if AUDIT_LOG_FILE is set)
RUN mkdir -p /app/logs && chmod 755 /app/logs

# Create dedicated non-root user for gitrepublic
# Using a dedicated user (not generic 'nodejs') is better security practice
# Use UID/GID 10000 to avoid conflicts with common system users (1000-9999)
# This can be overridden via build args if needed for specific deployments
ARG GITREPUBLIC_UID=10000
ARG GITREPUBLIC_GID=10000

# Create gitrepublic group and user with standardized UID/GID
# Using 10000 avoids conflicts with common system users while being predictable
RUN addgroup -g $GITREPUBLIC_GID -S gitrepublic && \
    adduser -S gitrepublic -u $GITREPUBLIC_UID -G gitrepublic && \
    chown -R gitrepublic:gitrepublic /app /repos /app/logs && \
    chown -R gitrepublic:gitrepublic /app/docs && \
    echo "Created gitrepublic user (UID: $GITREPUBLIC_UID, GID: $GITREPUBLIC_GID)"

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create entrypoint wrapper that runs as root initially to fix permissions
# Then switches to gitrepublic user
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Note: We start as root to fix permissions, then switch to gitrepublic user
# This allows the entrypoint to fix permissions on mounted volumes
USER root

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

# Start the application (entrypoint will switch to gitrepublic user)
CMD ["node", "build"]
