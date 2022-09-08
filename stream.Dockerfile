FROM node:16-alpine as deps

WORKDIR /app

COPY package.json .
COPY .npmrc .
COPY tsconfig.json .
COPY packages/stream/package.json ./packages/stream/package.json

# add tools for native dependencies (node-gpy)
RUN apk add --no-cache --virtual .gyp python3 make g++ \
    && npm set progress=false \
    && npm install --omit=dev \
    && cp -R node_modules prod_node_modules \
    && npm install \
    && apk del .gyp

COPY packages/stream ./packages/stream

FROM deps as build

FROM 016437323894.dkr.ecr.us-east-1.amazonaws.com/prod-gql:deps as nft-backend
COPY --from=nft-backend /app/packages/shared /app/packages/shared

WORKDIR /app/packages/stream
RUN npm run build


FROM node:16-alpine as release

WORKDIR /app


COPY --from=deps /app/prod_node_modules ./node_modules

COPY --from=build /app/packages/stream/package.json /app/packages/stream/package.json
COPY --from=build /app/packages/stream/dist /app/packages/stream/dist
COPY --from=build /app/packages/stream/.env /app/packages/stream/.env

WORKDIR /app/packages/stream

EXPOSE 8080

CMD ["npm", "start"]