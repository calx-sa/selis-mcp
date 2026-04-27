# MCP server for Selis PMO. Runs in HTTP+SSE mode for remote OAuth-based connections.
FROM node:24-alpine

WORKDIR /app

RUN npm install --omit=dev @calx/selis-mcp@0.2.2

# Default env. Override SELIS_ENV to switch (local|dev|stage|demo|prod).
ENV SELIS_ENV=dev
ENV SELIS_ORG=
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV PORT=3773

EXPOSE 3773

# HTTP mode: SSE transport on :3773. OAuth endpoints discoverable via /.well-known/*
CMD ["sh", "-c", "node node_modules/@calx/selis-mcp/src/index.mjs \"${SELIS_ENV}\" \"${SELIS_ORG}\" --http ${PORT}"]
