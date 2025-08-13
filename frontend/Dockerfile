# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
RUN npm ci || npm i

# Build
COPY . .
RUN npm run build

# ---------- runtime stage ----------
FROM nginx:alpine
# Nginx config that proxies /api -> backend
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Static assets
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx","-g","daemon off;"]
