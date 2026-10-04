# Build stage
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml* ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Next.js inlines NEXT_PUBLIC_* at build time, so these must be present as build
# args; passing them only through env_file at runtime does not reach the client
# bundle. Defaults match a workstation install.
ARG NEXT_PUBLIC_BACKEND_URI=http://localhost:8080
ARG NEXT_PUBLIC_DEPLOYMENT=LOCAL
ENV NEXT_PUBLIC_BACKEND_URI=$NEXT_PUBLIC_BACKEND_URI
ENV NEXT_PUBLIC_DEPLOYMENT=$NEXT_PUBLIC_DEPLOYMENT

COPY . .

RUN NODE_OPTIONS="--max-old-space-size=4096" pnpm run build

# Runtime stage
FROM base AS runner
WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/package.json ./
COPY --from=builder /usr/src/app/pnpm-lock.yaml ./
COPY --from=builder /usr/src/app/.next ./.next
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/next.config.js ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

EXPOSE 3000

CMD ["pnpm", "start"]
