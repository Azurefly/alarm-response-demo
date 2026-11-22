FROM node:22-bookworm-slim
WORKDIR /demo
COPY src ./src
COPY public ./public
COPY scripts ./scripts
USER node
ENV ALARM_BIND=0.0.0.0
EXPOSE 8080
CMD ["node", "src/server.mjs"]
