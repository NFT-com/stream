FROM node:16-alpine as deps

WORKDIR /app

COPY stream/package.json .
COPY stream/.npmrc . 
COPY stream/.npmrc ./stream/.npmrc
COPY stream/tsconfig.json .
COPY stream/tsconfig.json ./stream/tsconfig.json
COPY NFT-backend/tsconfig.json ./NFT-backend/tsconfig.json
COPY NFT-backend/packages/gql/tsconfig.json ./NFT-backend/packages/gql/tsconfig.json
COPY stream/packages/stream/package.json ./stream/packages/stream/package.json
COPY NFT-backend/packages/shared/package.json ./NFT-backend/packages/shared/package.json
COPY NFT-backend/packages/gql/package.json ./NFT-backend/packages/gql/package.json

# add tools for native dependencies (node-gpy)
RUN apk add --no-cache --virtual .gyp python3 make g++ \
    && npm set progress=false \
    && npm install --omit=dev \
    && cp -R node_modules prod_node_modules \
    && npm install \
    && apk del .gyp

COPY stream/packages/stream ./stream/packages/stream
COPY NFT-backend/packages/shared ./NFT-backend/packages/shared
COPY NFT-backend/packages/gql ./NFT-backend/packages/gql


FROM deps as build

WORKDIR /app/NFT-backend/packages/shared
RUN npm install
RUN npm run build

WORKDIR /app/NFT-backend/packages/gql
RUN npm install
RUN npm run build

WORKDIR /app/stream/packages/stream
RUN npm install
RUN npm run build


FROM node:16-alpine as release

WORKDIR /app

COPY --from=deps /app/prod_node_modules ./node_modules
COPY --from=deps /app/prod_node_modules /app/stream/node_modules
COPY --from=build /app/NFT-backend/packages/shared/node_modules /app/NFT-backend/packages/shared/node_modules
COPY --from=build /app/NFT-backend/packages/gql/node_modules /app/NFT-backend/packages/gql/node_modules
COPY --from=build /app/stream/packages/stream/node_modules /app/stream/packages/stream/node_modules

COPY --from=build /app/NFT-backend/packages/shared/package.json /app/NFT-backend/packages/shared/package.json
COPY --from=build /app/NFT-backend/packages/shared/dist /app/NFT-backend/packages/shared/dist

COPY --from=build /app/NFT-backend/packages/gql/package.json /app/NFT-backend/packages/gql/package.json
COPY --from=build /app/NFT-backend/packages/gql/dist /app/NFT-backend/packages/gql/dist
COPY --from=build /app/packages/gql/.env /app/packages/gql/.env

COPY --from=build /app/stream/packages/stream/package.json /app/stream/packages/stream/package.json
COPY --from=build /app/stream/packages/stream/dist /app/stream/packages/stream/dist
COPY --from=build /app/stream/packages/stream/.env /app/stream/packages/stream/.env

COPY --from=deps /app/package.json /app/stream/package.json

WORKDIR /app/stream/packages/stream

EXPOSE 8080

CMD ["npm", "start"]