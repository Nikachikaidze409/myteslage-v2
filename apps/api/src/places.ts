import { createHash } from "node:crypto";
import Redis from "ioredis";

export type PlaceSuggestion = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  fullText: string;
};

export type PlaceSelection = {
  placeId: string;
  name: string;
  address: string;
  location: {
    lat: number;
    lng: number;
  };
};

type AutocompleteInput = {
  input: string;
  sessionToken: string;
  lat?: number;
  lng?: number;
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

const inflightAutocomplete = new Map<string, Promise<PlaceSuggestion[]>>();

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

function normalizeQuery(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function roundedCoordinate(value?: number) {
  if (!Number.isFinite(value)) return "";
  return Number(value).toFixed(3);
}

function autocompleteCacheKey(input: AutocompleteInput) {
  return [
    "places:auto:v1",
    compactHash(input.sessionToken),
    compactHash(normalizeQuery(input.input)),
    roundedCoordinate(input.lat),
    roundedCoordinate(input.lng)
  ].join(":");
}

function parseSuggestion(item: any): PlaceSuggestion | null {
  const prediction = item?.placePrediction;

  if (!prediction?.placeId) return null;

  const mainText =
    prediction.structuredFormat?.mainText?.text ??
    prediction.text?.text ??
    "Unknown place";

  const secondaryText =
    prediction.structuredFormat?.secondaryText?.text ?? "";

  return {
    placeId: prediction.placeId,
    mainText,
    secondaryText,
    fullText: prediction.text?.text ?? [mainText, secondaryText].filter(Boolean).join(", ")
  };
}

async function fetchAutocomplete(input: AutocompleteInput): Promise<PlaceSuggestion[]> {
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_SERVER_API_KEY is not configured");
  }

  const body: Record<string, unknown> = {
    input: input.input,
    sessionToken: input.sessionToken,
    languageCode: "ka",
    regionCode: "GE"
  };

  if (Number.isFinite(input.lat) && Number.isFinite(input.lng)) {
    body.locationBias = {
      circle: {
        center: {
          latitude: input.lat,
          longitude: input.lng
        },
        radius: 50000
      }
    };
  }

  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Places autocomplete failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as { suggestions?: unknown[] };

  return (data.suggestions ?? [])
    .map(parseSuggestion)
    .filter((item): item is PlaceSuggestion => Boolean(item))
    .slice(0, 6);
}

export async function autocompletePlaces(input: AutocompleteInput): Promise<PlaceSuggestion[]> {
  const normalized = normalizeQuery(input.input);

  if (normalized.length < 2) return [];

  const cacheKey = autocompleteCacheKey({
    ...input,
    input: normalized
  });

  await ensureRedis();

  if (redis && redisReady) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as PlaceSuggestion[];
    } catch {
      redisReady = false;
    }
  }

  const existing = inflightAutocomplete.get(cacheKey);
  if (existing) return existing;

  const request = fetchAutocomplete({
    ...input,
    input: normalized
  })
    .then(async (results) => {
      if (redis && redisReady) {
        try {
          await redis.set(cacheKey, JSON.stringify(results), "EX", 45);
        } catch {
          redisReady = false;
        }
      }

      return results;
    })
    .finally(() => {
      inflightAutocomplete.delete(cacheKey);
    });

  inflightAutocomplete.set(cacheKey, request);

  return request;
}

export async function getPlaceDetails(
  placeId: string,
  sessionToken: string
): Promise<PlaceSelection> {
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_SERVER_API_KEY is not configured");
  }

  const url = new URL(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`
  );

  if (sessionToken) {
    url.searchParams.set("sessionToken", sessionToken);
  }

  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "id,displayName,formattedAddress,location"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Place details failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  };

  const lat = data.location?.latitude;
  const lng = data.location?.longitude;

  if (!data.id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Place details response did not include a valid location");
  }

  return {
    placeId: data.id,
    name: data.displayName?.text ?? data.formattedAddress ?? "Destination",
    address: data.formattedAddress ?? "",
    location: {
      lat: Number(lat),
      lng: Number(lng)
    }
  };
}
