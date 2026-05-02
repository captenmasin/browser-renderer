FROM ghcr.io/puppeteer/puppeteer:23

WORKDIR /home/pptruser/app

COPY --chown=pptruser:pptruser package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --chown=pptruser:pptruser server.js ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
