FROM ghcr.io/openinsighthq/pi-runtime:latest AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/ ./packages/
RUN npm ci || npm install

COPY . .
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /out && \
	cp package.json /out/ && \
	cp -a node_modules /out/node_modules && \
	for d in packages/*/; do \
		name="$(basename "$d")"; \
		mkdir -p "/out/packages/$name"; \
		[ -f "$d/package.json" ] && cp "$d/package.json" "/out/packages/$name/"; \
		[ -d "$d/dist" ] && cp -a "$d/dist" "/out/packages/$name/"; \
	done

FROM ghcr.io/openinsighthq/pi-runtime:latest
WORKDIR /app
COPY --from=builder /out/ .

EXPOSE 3000
CMD ["node", "packages/coding-agent/dist/cli.js", "--mode", "http", "--http-port", "3000"]
