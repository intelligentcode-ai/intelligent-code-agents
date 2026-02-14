FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build:dashboard:web

FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

COPY --from=build /app/dist/installer-dashboard/web-build/ /usr/share/nginx/html/
COPY src/installer-dashboard/nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
