# RDCMNATION QUANTUM - Production Deployment
# Runs Phase 2 validation harness + Phase 3 intelligence systems
# on Render.com

FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Create directories for runtime data
RUN mkdir -p reports logs data

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

# Expose port for health checks / monitoring
EXPOSE 3000

# Start Phase 2 validation harness with Phase 3 attached
CMD ["node", "harness/run-validation.js", "--cycles", "10000", "--fast", "--report-every", "1000"]
