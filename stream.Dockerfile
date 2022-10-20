FROM node:16-alpine as deps

WORKDIR /app

COPY stream/package*.json ./stream/
COPY stream/.npmrc ./stream/.npmrc
COPY stream/tsconfig.json ./stream/tsconfig.json
COPY NFT-backend/package*.json ./NFT-backend/
COPY NFT-backend/.npmrc ./NFT-backend/.npmrc
COPY NFT-backend/tsconfig.json ./NFT-backend/tsconfig.json
COPY stream/packages/stream/package*.json ./stream/packages/stream/
COPY NFT-backend/packages/shared/package*.json ./NFT-backend/packages/shared/
COPY NFT-backend/packages/gql/package*.json ./NFT-backend/packages/gql/


# add tools for native dependencies (node-gpy)
RUN apk add --no-cache --virtual .gyp python3 make g++ \
    && npm set progress=false \
    && cd /app/stream \
    && npm ci --omit=dev \
    && cp -R node_modules prod_node_modules \
    && npm ci \
    && cd /app/NFT-backend \
    && npm ci --omit=dev \
    && cp -R node_modules prod_node_modules \
    && npm ci \
    && apk del .gyp

COPY stream/packages/stream ./stream/packages/stream
COPY NFT-backend/packages/shared ./NFT-backend/packages/shared
COPY NFT-backend/packages/gql ./NFT-backend/packages/gql

FROM deps as build

WORKDIR /app/NFT-backend/packages/shared
RUN npm run build

WORKDIR /app/NFT-backend/packages/gql
RUN npm install
RUN npm run build

WORKDIR /app/stream/packages/stream
RUN npm run build



FROM node:16-alpine as release

WORKDIR /app

COPY --from=deps /app/stream/prod_node_modules ./stream/node_modules
COPY --from=deps /app/NFT-backend/prod_node_modules ./NFT-backend/node_modules
#COPY --from=build /app/NFT-backend/packages/shared/node_modules ./NFT-backend/packages/shared/node_modules
COPY --from=build /app/NFT-backend/packages/gql/node_modules ./NFT-backend/packages/gql/node_modules
#COPY --from=build /app/stream/packages/stream/node_modules ./stream/packages/stream/node_modules

COPY --from=build /app/NFT-backend/packages/shared/package.json ./NFT-backend/packages/shared/package.json
COPY --from=build /app/NFT-backend/packages/shared/dist ./NFT-backend/packages/shared/dist


COPY --from=build /app/NFT-backend/packages/gql/package.json ./NFT-backend/packages/gql/package.json
COPY --from=build /app/NFT-backend/packages/gql/dist ./NFT-backend/packages/gql/dist

COPY --from=build /app/stream/packages/stream/package.json ./stream/packages/stream/package.json
COPY --from=build /app/stream/packages/stream/dist ./stream/packages/stream/dist

WORKDIR /app/stream/packages/stream

EXPOSE 8080

CMD ["npm", "start"]