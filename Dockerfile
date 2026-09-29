FROM node:20-bookworm-slim

WORKDIR /app
COPY . .

EXPOSE 10000
CMD ["node", "server.js"]
