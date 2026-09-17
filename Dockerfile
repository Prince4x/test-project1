# Teen Patti Arena — container image
#
# The game has zero runtime dependencies, so the image is tiny and the build
# takes seconds. Deploy this anywhere that runs a container (Render, Railway,
# Fly.io, a VPS, your own Docker host).
#
#   docker build -t teen-patti .
#   docker run -p 4000:4000 -e PUBLIC_URL=https://cards.example.com teen-patti

FROM node:22-alpine

WORKDIR /app

# Only the files the server needs at runtime — no dev dependencies, no tests.
COPY package.json ./
COPY server ./server
COPY src ./src
COPY public ./public
COPY tools ./tools
COPY PLAY-ME-first.html ./

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

EXPOSE 4000

# The container has no browser; health check the API instead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
