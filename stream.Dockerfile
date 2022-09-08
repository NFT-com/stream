FROM node:16-alpine as deps

WORKDIR /app

COPY stream/package.json .
COPY stream/.npmrc .
COPY stream/tsconfig.json .
COPY NFT-backend/tsconfig.json ./NFT-backend/tsconfig.json
COPY stream/packages/stream/package.json ./stream/packages/stream/package.json
COPY NFT-backend/packages/shared/package.json ./NFT-backend/packages/shared/package.json

# add tools for native dependencies (node-gpy)
RUN apk add --no-cache --virtual .gyp python3 make g++ \
    && npm set progress=false \
    && npm install --omit=dev \
    && cp -R node_modules prod_node_modules \
    && npm install \
    && apk del .gyp

COPY stream/packages/stream ./stream/packages/stream
COPY NFT-backend/packages/shared ./NFT-backend/packages/shared


FROM deps as build

WORKDIR /app/NFT-backend/packages/shared
RUN npm run build

WORKDIR /app/stream/packages/stream
RUN npm run build

WORKDIR /app/NFT-backend/packages/shared
RUN npm install


FROM node:16-alpine as release

WORKDIR /app


COPY --from=deps /app/prod_node_modules ./stream/node_modules
COPY --from=deps /app/NFT-backend/packages/shared/node_modules ./NFT-backend/packages/shared/node_modules

COPY --from=build /app/NFT-backend/packages/shared/package.json /app/NFT-backend/packages/shared/package.json
COPY --from=build /app/NFT-backend/packages/shared/dist /app/NFT-backend/packages/shared/dist

COPY --from=build /app/stream/packages/stream/package.json /app/packages/stream/package.json
COPY --from=build /app/stream/packages/stream/dist /app/packages/stream/dist
COPY --from=build /app/stream/packages/stream/.env /app/packages/stream/.env

WORKDIR /app/stream/packages/stream

EXPOSE 8080

CMD ["npm", "start"]