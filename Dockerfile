FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
EXPOSE 3000
# Apply migrations, load synthetic data if the database is empty, then serve.
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed && pnpm start"]
