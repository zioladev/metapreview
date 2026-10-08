# metapreview on any Docker host (e.g. Render). Build from this folder:
#   docker build -t metapreview . && docker run -p 3000:3000 metapreview
FROM oven/bun:1.3-slim
WORKDIR /app

# No dependencies to install: it's one Bun file and one HTML page.
COPY server.ts ./
COPY public ./public

ENV NODE_ENV=production
# Listens on $PORT (Render sets it), falling back to 3000.
EXPOSE 3000
CMD ["bun", "server.ts"]
