FROM node:22-slim
WORKDIR /app/pinball-pals
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DB_PATH=/data/pinball-pals.sqlite
VOLUME /data
EXPOSE 8080 9000
CMD ["node", "server/src/index.js"]
