# Linux end-to-end test image for copilot-reverse.
#
# Builds the project and runs a REAL supervisor inside the container so the GitHub-token heartbeat
# can be exercised over actual HTTP (GET /api/status) against the real GitHub API — something the
# Windows host can't easily do because port 7890 is taken by a running instance. The container has its
# own network namespace, so the default ports are free here.
#
# Uses node:20 (not -slim) because better-sqlite3 is a native module that needs a C++ toolchain.
#
# Build:  docker build -f e2e/docker/Dockerfile -t copilot-reverse-e2e .
# Run:    docker run --rm \
#           -v "$HOME/.cc-fleet/creds.json:/root/.cc-fleet/creds.json:ro" \
#           copilot-reverse-e2e
# (mounting creds.json is optional — without it the "connected" case is reported as skipped.)

FROM node:20

WORKDIR /app

# Install deps first (layer-cached unless the lockfile changes). Native better-sqlite3 compiles here.
COPY package.json package-lock.json ./
RUN npm ci

# Bring in the source and build to dist/.
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY e2e ./e2e
COPY tests ./tests
RUN npm run build

# The e2e driver boots the supervisor, probes /api/status, and asserts the github field's states.
ENTRYPOINT ["node", "e2e/docker/heartbeat-e2e.mjs"]
