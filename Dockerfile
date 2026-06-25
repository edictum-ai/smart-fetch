# captatum hosted MCP server. Node 24 native TS, pnpm 10.32.0, Chromium for Tier-3.
FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

RUN corepack enable \
  && corepack prepare pnpm@10.32.0 --activate \
  && pnpm install --prod --frozen-lockfile

RUN pnpm exec playwright install chromium --with-deps

COPY src ./src

USER node

EXPOSE 3000

CMD ["node", "--no-warnings", "src/server.ts"]
