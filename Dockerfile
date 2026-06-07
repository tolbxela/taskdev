FROM node:20-alpine AS build
WORKDIR /app

COPY site/package*.json ./
RUN npm ci

COPY site/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
