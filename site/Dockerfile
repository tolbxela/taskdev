FROM node:20-alpine AS build
WORKDIR /app/site

COPY site/package*.json ./
RUN npm ci

COPY docs /app/docs
COPY site ./
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/site/dist /usr/share/nginx/html
