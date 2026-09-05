# M4 black-box image: real supervisor/gateway/control runtime with a deterministic devtunnel CLI shim.
FROM node:22
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set registry "$NPM_REGISTRY"
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY e2e ./e2e
RUN npm run build
ENTRYPOINT ["node", "e2e/docker/m4-e2e.mjs"]
