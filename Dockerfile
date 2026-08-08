FROM node:22-slim AS build
WORKDIR /srv
COPY package.json tsconfig.json ./
RUN npm install --silent
COPY src ./src
COPY test ./test
RUN npx tsc && node --test dist/test/*.test.js

FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production PORT=8000
COPY --from=build /srv/dist ./dist
COPY public ./public
EXPOSE 8000
CMD ["node","dist/src/server.js"]
