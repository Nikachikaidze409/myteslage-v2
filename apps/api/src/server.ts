import Fastify from "fastify";
import cors from "@fastify/cors";
import { autocompletePlaces, getPlaceDetails } from "./places.js";
import { computeRoute } from "./routes.js";

const app = Fastify({ logger: true });

const searchRateLimit = new Map<string, { windowStart: number; count: number }>();
const SEARCH_RATE_WINDOW_MS = 60_000;
const SEARCH_RATE_MAX = 40;

function allowSearchRequest(ip: string) {
  const now = Date.now();
  const current = searchRateLimit.get(ip);

  if (!current || now - current.windowStart >= SEARCH_RATE_WINDOW_MS) {
    searchRateLimit.set(ip, { windowStart: now, count: 1 });
    return true;
  }

  if (current.count >= SEARCH_RATE_MAX) {
    return false;
  }

  current.count += 1;
  return true;
}

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

app.post<{
  Body: {
    input?: string;
    sessionToken?: string;
    lat?: number;
    lng?: number;
  };
}>("/api/v1/places/autocomplete", async (request, reply) => {
  if (!allowSearchRequest(request.ip)) {
    return reply.code(429).send({
      error: "Too many search requests. Please wait a moment."
    });
  }

  const input = request.body?.input?.trim() ?? "";
  const sessionToken = request.body?.sessionToken?.trim() ?? "";
  const lat = request.body?.lat;
  const lng = request.body?.lng;

  if (input.length < 2 || input.length > 160) {
    return reply.code(400).send({
      error: "Search input must contain between 2 and 160 characters."
    });
  }

  if (sessionToken.length < 8 || sessionToken.length > 128) {
    return reply.code(400).send({
      error: "A valid search session token is required."
    });
  }

  if (
    (lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
    (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180))
  ) {
    return reply.code(400).send({
      error: "Invalid search location."
    });
  }

  try {
    const suggestions = await autocompletePlaces({
      input,
      sessionToken,
      lat,
      lng
    });

    return {
      suggestions
    };
  } catch (error) {
    request.log.error(error);

    return reply.code(502).send({
      error: "Place search is temporarily unavailable."
    });
  }
});

app.post<{
  Body: {
    origin?: { lat?: number; lng?: number };
    destination?: { lat?: number; lng?: number };
  };
}>("/api/v1/routes/compute", async (request, reply) => {
  const origin = request.body?.origin;
  const destination = request.body?.destination;

  const validPoint = (point?: { lat?: number; lng?: number }) =>
    Boolean(
      point &&
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lng) &&
        Number(point.lat) >= -90 &&
        Number(point.lat) <= 90 &&
        Number(point.lng) >= -180 &&
        Number(point.lng) <= 180
    );

  if (!validPoint(origin) || !validPoint(destination)) {
    return reply.code(400).send({ error: "Valid origin and destination are required." });
  }

  try {
    return await computeRoute({
      origin: { lat: Number(origin!.lat), lng: Number(origin!.lng) },
      destination: { lat: Number(destination!.lat), lng: Number(destination!.lng) }
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ error: "Route calculation is temporarily unavailable." });
  }
});

app.get<{
  Params: {
    placeId: string;
  };
  Querystring: {
    sessionToken?: string;
  };
}>("/api/v1/places/:placeId", async (request, reply) => {
  const placeId = request.params.placeId?.trim() ?? "";
  const sessionToken = request.query.sessionToken?.trim() ?? "";

  if (!placeId || placeId.length > 256) {
    return reply.code(400).send({
      error: "A valid place ID is required."
    });
  }

  if (sessionToken.length < 8 || sessionToken.length > 128) {
    return reply.code(400).send({
      error: "A valid search session token is required."
    });
  }

  try {
    return await getPlaceDetails(placeId, sessionToken);
  } catch (error) {
    request.log.error(error);

    return reply.code(502).send({
      error: "Place details are temporarily unavailable."
    });
  }
});

const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? "0.0.0.0";

await app.listen({ port, host });
