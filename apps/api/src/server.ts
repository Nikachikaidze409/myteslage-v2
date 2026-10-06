import Fastify from "fastify";
import cors from "@fastify/cors";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: false
});

app.get("/health", async () => ({
  ok: true,
  service: "myteslage-api",
  timestamp: new Date().toISOString()
}));

app.get("/api/v1/status", async () => ({
  version: "v2",
  architecture: "self-hosted"
}));

const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? "0.0.0.0";

await app.listen({ port, host });
