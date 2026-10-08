import { createHash } from "node:crypto";
import { Redis } from "ioredis";

export type RoutePoint = {
  lat: number;
  lng: number;
};

export type RouteStep = {
  distanceMeters: number;
  maneuver: string;
  instruction: string;
  encodedPolyline: string;
};

export type RouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  staticDurationSeconds: number | null;
  encodedPolyline: string;
  steps: RouteStep[];
};

type RouteInput = {
  origin: RoutePoint;
  destination: RoutePoint;
};

const apiKey = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim() ?? "";
const redisUrl = process.env.REDIS_URL?.trim();

const redis = redisUrl
  ? new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true
    })
  : null;

let redisReady = false;

if (redis) {
  redis.on("error", () => {
    redisReady = false;
  });
}

const inflightRoutes = new Map<string, Promise<RouteResult>>();

async function ensureRedis() {
  if (!redis || redisReady) return;

  try {
    if (redis.status === "wait") {
      await redis.connect();
    }
    await redis.ping();
    redisReady = true;
  } catch {
    redisReady = false;
  }
}

function compactHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function rounded(value: number, digits: number) {
  return Number(value).toFixed(digits);
}

function routeCacheKey(input: RouteInput) {
  const key = [
    rounded(input.origin.lat, 4),
    rounded(input.origin.lng, 4),
    rounded(input.destination.lat, 5),
    rounded(input.destination.lng, 5)
  ].join(":");

  return `routes:v3:${compactHash(key)}`;
}

function parseDurationSeconds(value?: string) {
  if (!value) return 0;
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value);
  if (!match) return 0;
  return Math.round(Number(match[1]));
}

async function fetchRoute(input: RouteInput): Promise<RouteResult> {
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_SERVER_API_KEY is not configured");
  }

  const response = await fetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline"
      },
      body: JSON.stringify({
        origin: {
          location: {
            latLng: {
              latitude: input.origin.lat,
              longitude: input.origin.lng
            }
          }
        },
        destination: {
          location: {
            latLng: {
              latitude: input.destination.lat,
              longitude: input.destination.lng
            }
          }
        },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        polylineQuality: "OVERVIEW",
        polylineEncoding: "ENCODED_POLYLINE",
        computeAlternativeRoutes: false,
        languageCode: "ka",
        units: "METRIC"
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Routes compute failed: ${response.status} ${text.slice(0, 500)}`
    );
  }

  const data = (await response.json()) as {
    routes?: Array<{
      distanceMeters?: number;
      duration?: string;
      staticDuration?: string;
      polyline?: {
        encodedPolyline?: string;
      };
      legs?: Array<{
        steps?: Array<{
          distanceMeters?: number;
          navigationInstruction?: {
            maneuver?: string;
            instructions?: string;
          };
          polyline?: {
            encodedPolyline?: string;
          };
        }>;
      }>;
    }>;
  };

  const route = data.routes?.[0];

  if (!route?.polyline?.encodedPolyline || !route.distanceMeters) {
    throw new Error("Routes response did not include a usable route");
  }

  const steps: RouteStep[] = (route.legs ?? [])
    .flatMap((leg) => leg.steps ?? [])
    .map((step) => ({
      distanceMeters: Math.max(0, Number(step.distanceMeters ?? 0)),
      maneuver: step.navigationInstruction?.maneuver ?? "STRAIGHT",
      instruction:
        step.navigationInstruction?.instructions ??
        "Continue on the current road",
      encodedPolyline: step.polyline?.encodedPolyline ?? ""
    }))
    .filter((step) => step.distanceMeters > 0 || step.instruction.length > 0);

  return {
    distanceMeters: route.distanceMeters,
    durationSeconds: parseDurationSeconds(route.duration),
    staticDurationSeconds: route.staticDuration
      ? parseDurationSeconds(route.staticDuration)
      : null,
    encodedPolyline: route.polyline.encodedPolyline,
    steps
  };
}

export async function computeRoute(input: RouteInput): Promise<RouteResult> {
  const cacheKey = routeCacheKey(input);

  await ensureRedis();

  if (redis && redisReady) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as RouteResult;
    } catch {
      redisReady = false;
    }
  }

  const existing = inflightRoutes.get(cacheKey);
  if (existing) return existing;

  const request = fetchRoute(input)
    .then(async (route) => {
      if (redis && redisReady) {
        try {
          await redis.set(cacheKey, JSON.stringify(route), "EX", 30);
        } catch {
          redisReady = false;
        }
      }

      return route;
    })
    .finally(() => {
      inflightRoutes.delete(cacheKey);
    });

  inflightRoutes.set(cacheKey, request);

  return request;
}
