# Сборка в два этапа: в готовый образ не попадают ни инструменты сборки, ни
# исходники клиента — только собранный dist и серверные зависимости.
FROM node:24-slim AS build

WORKDIR /app

# Сначала манифесты: слой с установкой зависимостей переиспользуется, пока они
# не изменились, и пересборка после правки кода занимает секунды.
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
COPY native-plugins ./native-plugins
RUN npm ci --ignore-scripts && npm --prefix server ci

COPY . .

# Адрес API пустой намеренно: браузер берёт клиент с того же домена, что и API,
# поэтому относительные пути верны. Абсолютный адрес нужен только сборке для iOS.
RUN npm run build

FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Загрузки лежат в томе, а не в образе: иначе они исчезали бы при обновлении.
VOLUME ["/data/uploads"]

EXPOSE 4000
CMD ["node", "server/src/index.js"]
