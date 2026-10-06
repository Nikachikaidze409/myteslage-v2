FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_GOOGLE_MAPS_BROWSER_API_KEY
ENV VITE_GOOGLE_MAPS_BROWSER_API_KEY=$VITE_GOOGLE_MAPS_BROWSER_API_KEY

COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN npm install --workspace apps/web

COPY apps/web ./apps/web

RUN npm --workspace apps/web run build

FROM nginx:1.27-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
