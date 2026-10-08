import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "./googleMaps";

type GpsState = "loading" | "live" | "denied" | "unavailable" | "error";
type ThemeMode = "light" | "dark";
type ArrivalState = "none" | "arriving" | "arrived";

type PositionSample = {
  point: google.maps.LatLngLiteral;
  timestamp: number;
};

type PlaceSuggestion = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  fullText: string;
};

type PlaceSelection = {
  placeId: string;
  name: string;
  address: string;
  location: {
    lat: number;
    lng: number;
  };
};

type RouteStep = {
  distanceMeters: number;
  maneuver: string;
  instruction: string;
  encodedPolyline: string;
};

type RouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  staticDurationSeconds: number | null;
  encodedPolyline: string;
  steps: RouteStep[];
};

type RouteProgress = {
  distanceFromRouteMeters: number;
  remainingGeometryMeters: number;
  totalGeometryMeters: number;
};

type RouteMatch = {
  snappedPoint: google.maps.LatLngLiteral;
  heading: number;
  distanceFromRouteMeters: number;
  segmentIndex: number;
  progressMeters: number;
  remainingGeometryMeters: number;
  totalGeometryMeters: number;
};

const TBILISI = { lat: 41.7151, lng: 44.8271 };
const THEME_STORAGE_KEY = "tmap-theme";
const CAMERA_UPDATE_MIN_MS = 250;
const MIN_BEARING_DISTANCE_METERS = 8;
const REROUTE_COOLDOWN_MS = 8000;
const POOR_GPS_ACCURACY_METERS = 80;
const PROGRESS_UI_MIN_MS = 750;
const ARRIVING_ROUTE_METERS = 140;
const ARRIVAL_CONFIRM_FIXES = 2;
const ARRIVAL_NOTICE_MS = 6000;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function normalizeHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function shortestHeadingDelta(from: number, to: number) {
  return ((to - from + 540) % 360) - 180;
}

function smoothHeading(previous: number | null, next: number, alpha = 0.3) {
  if (previous === null) return normalizeHeading(next);
  return normalizeHeading(previous + shortestHeadingDelta(previous, next) * alpha);
}

function distanceMeters(a: google.maps.LatLngLiteral, b: google.maps.LatLngLiteral) {
  const earthRadius = 6371000;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a: google.maps.LatLngLiteral, b: google.maps.LatLngLiteral) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLng = toRadians(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return normalizeHeading(toDegrees(Math.atan2(y, x)));
}

function destinationPoint(
  start: google.maps.LatLngLiteral,
  heading: number,
  distance: number
): google.maps.LatLngLiteral {
  const earthRadius = 6371000;
  const angularDistance = distance / earthRadius;
  const bearing = toRadians(heading);
  const lat1 = toRadians(start.lat);
  const lng1 = toRadians(start.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: toDegrees(lat2),
    lng: normalizeHeading(toDegrees(lng2) + 180) - 180
  };
}

function locationDotIcon(): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 9,
    fillColor: "#2563EB",
    fillOpacity: 1,
    strokeColor: "#FFFFFF",
    strokeOpacity: 1,
    strokeWeight: 3.5
  };
}

function navigationArrowIcon(heading: number): google.maps.Symbol {
  return {
    path: "M 0 -13 L 8.5 10 L 0 7 L -8.5 10 Z",
    scale: 1,
    fillColor: "#2563EB",
    fillOpacity: 1,
    strokeColor: "#FFFFFF",
    strokeOpacity: 1,
    strokeWeight: 2.2,
    rotation: normalizeHeading(heading)
  };
}

function destinationIcon(): google.maps.Symbol {
  return {
    path: "M 0 -14 C 8 -14 13 -9 13 -2 C 13 7 0 16 0 16 C 0 16 -13 7 -13 -2 C -13 -9 -8 -14 0 -14 Z",
    scale: 1,
    fillColor: "#7C3AED",
    fillOpacity: 1,
    strokeColor: "#FFFFFF",
    strokeOpacity: 1,
    strokeWeight: 2.4,
    anchor: new google.maps.Point(0, 16)
  };
}

function decodePolyline(encoded: string): google.maps.LatLngLiteral[] {
  const path: google.maps.LatLngLiteral[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    path.push({
      lat: lat / 1e5,
      lng: lng / 1e5
    });
  }

  return path;
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.max(1, Math.round(meters))} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

function formatDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function maneuverIcon(maneuver: string) {
  const value = maneuver.toUpperCase();

  if (value.includes("U_TURN")) return "↶";
  if (value.includes("TURN_LEFT") || value.includes("RAMP_LEFT") || value.includes("FORK_LEFT")) return "←";
  if (value.includes("TURN_RIGHT") || value.includes("RAMP_RIGHT") || value.includes("FORK_RIGHT")) return "→";
  if (value.includes("SLIGHT_LEFT")) return "↖";
  if (value.includes("SLIGHT_RIGHT")) return "↗";
  if (value.includes("SHARP_LEFT")) return "↙";
  if (value.includes("SHARP_RIGHT")) return "↘";
  if (value.includes("ROUNDABOUT")) return "↻";
  if (value.includes("MERGE")) return "↗";
  return "↑";
}

function currentRouteStep(route: RouteResult | null, remainingDistanceMeters: number | null) {
  if (!route || route.steps.length === 0) return null;

  const remaining =
    remainingDistanceMeters === null
      ? route.distanceMeters
      : clamp(remainingDistanceMeters, 0, route.distanceMeters);

  const traveled = Math.max(0, route.distanceMeters - remaining);
  let cumulative = 0;

  for (const step of route.steps) {
    cumulative += step.distanceMeters;

    if (traveled <= cumulative) {
      return {
        ...step,
        distanceToManeuverMeters: Math.max(0, cumulative - traveled)
      };
    }
  }

  const last = route.steps[route.steps.length - 1];
  return {
    ...last,
    distanceToManeuverMeters: 0
  };
}

function createSearchSessionToken() {
  try {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Use the fallback below.
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function buildDetailedRoutePath(route: RouteResult) {
  const detailed = route.steps
    .filter((step) => step.encodedPolyline)
    .flatMap((step) => decodePolyline(step.encodedPolyline));

  if (detailed.length >= 2) return detailed;
  return decodePolyline(route.encodedPolyline);
}

function buildCumulativeDistances(path: google.maps.LatLngLiteral[]) {
  const cumulative = [0];

  for (let index = 0; index < path.length - 1; index += 1) {
    cumulative.push(
      cumulative[index] + distanceMeters(path[index], path[index + 1])
    );
  }

  return cumulative;
}

function matchPointToRoute(
  point: google.maps.LatLngLiteral,
  path: google.maps.LatLngLiteral[],
  cumulative: number[],
  previousSegmentIndex: number | null,
  previousProgressMeters: number,
  accuracyMeters: number
): RouteMatch | null {
  if (path.length < 2 || cumulative.length !== path.length) return null;

  const earthRadius = 6371000;
  const latScale = earthRadius * (Math.PI / 180);
  const lngScale =
    earthRadius * Math.cos(toRadians(point.lat)) * (Math.PI / 180);

  const startIndex =
    previousSegmentIndex === null ? 0 : Math.max(0, previousSegmentIndex - 8);
  const endIndex =
    previousSegmentIndex === null
      ? path.length - 2
      : Math.min(path.length - 2, previousSegmentIndex + 45);

  let best:
    | {
        distance: number;
        segmentIndex: number;
        t: number;
        snappedPoint: google.maps.LatLngLiteral;
        progressMeters: number;
        heading: number;
      }
    | null = null;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const a = path[index];
    const b = path[index + 1];

    const ax = (a.lng - point.lng) * lngScale;
    const ay = (a.lat - point.lat) * latScale;
    const bx = (b.lng - point.lng) * lngScale;
    const by = (b.lat - point.lat) * latScale;

    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const t =
      denominator === 0
        ? 0
        : clamp(-(ax * dx + ay * dy) / denominator, 0, 1);

    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.hypot(px, py);
    const segmentLength = cumulative[index + 1] - cumulative[index];
    const progressMeters = cumulative[index] + segmentLength * t;

    const backwardTolerance = Math.max(20, Math.min(accuracyMeters * 0.35, 55));
    if (
      previousSegmentIndex !== null &&
      progressMeters < previousProgressMeters - backwardTolerance
    ) {
      continue;
    }

    const snappedPoint = {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t
    };

    if (!best || distance < best.distance) {
      best = {
        distance,
        segmentIndex: index,
        t,
        snappedPoint,
        progressMeters,
        heading: bearingDegrees(a, b)
      };
    }
  }

  if (!best) return null;

  const totalGeometryMeters = cumulative[cumulative.length - 1];

  return {
    snappedPoint: best.snappedPoint,
    heading: best.heading,
    distanceFromRouteMeters: best.distance,
    segmentIndex: best.segmentIndex,
    progressMeters: best.progressMeters,
    remainingGeometryMeters: Math.max(
      0,
      totalGeometryMeters - best.progressMeters
    ),
    totalGeometryMeters
  };
}

function routeHeadingForPoint(
  point: google.maps.LatLngLiteral,
  path: google.maps.LatLngLiteral[]
): number | null {
  if (path.length < 2) return null;

  const earthRadius = 6371000;
  const latScale = earthRadius * (Math.PI / 180);
  const lngScale =
    earthRadius * Math.cos(toRadians(point.lat)) * (Math.PI / 180);

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestHeading: number | null = null;

  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];

    const ax = (a.lng - point.lng) * lngScale;
    const ay = (a.lat - point.lat) * latScale;
    const bx = (b.lng - point.lng) * lngScale;
    const by = (b.lat - point.lat) * latScale;

    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const t =
      denominator === 0
        ? 0
        : clamp(-(ax * dx + ay * dy) / denominator, 0, 1);

    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.hypot(px, py);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestHeading = bearingDegrees(a, b);
    }
  }

  return bestHeading;
}

function routeProgress(
  point: google.maps.LatLngLiteral,
  path: google.maps.LatLngLiteral[]
): RouteProgress | null {
  if (path.length < 2) return null;

  const earthRadius = 6371000;
  const latScale = earthRadius * (Math.PI / 180);
  const lngScale =
    earthRadius * Math.cos(toRadians(point.lat)) * (Math.PI / 180);

  let totalGeometryMeters = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestBefore = 0;
  let accumulated = 0;

  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    const segmentLength = distanceMeters(a, b);

    const ax = (a.lng - point.lng) * lngScale;
    const ay = (a.lat - point.lat) * latScale;
    const bx = (b.lng - point.lng) * lngScale;
    const by = (b.lat - point.lat) * latScale;

    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const t =
      denominator === 0
        ? 0
        : clamp(-(ax * dx + ay * dy) / denominator, 0, 1);

    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.hypot(px, py);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestBefore = accumulated + segmentLength * t;
    }

    accumulated += segmentLength;
    totalGeometryMeters += segmentLength;
  }

  return {
    distanceFromRouteMeters: bestDistance,
    remainingGeometryMeters: Math.max(0, totalGeometryMeters - bestBefore),
    totalGeometryMeters
  };
}

export default function App() {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const locationMarkerRef = useRef<google.maps.Marker | null>(null);
  const destinationMarkerRef = useRef<google.maps.Marker | null>(null);
  const routePolylineRef = useRef<google.maps.Polyline | null>(null);
  const accuracyCircleRef = useRef<google.maps.Circle | null>(null);
  const lastPositionRef = useRef<google.maps.LatLngLiteral | null>(null);
  const previousSampleRef = useRef<PositionSample | null>(null);
  const smoothedHeadingRef = useRef<number | null>(null);
  const routeHeadingRef = useRef<number | null>(null);
  const lastSpeedRef = useRef(0);
  const lastCameraUpdateRef = useRef(0);
  const lastProgressUiUpdateRef = useRef(0);
  const followLocationRef = useRef(true);
  const vectorHeadingRef = useRef(true);
  const didInitialZoomRef = useRef(false);
  const searchSessionTokenRef = useRef(createSearchSessionToken());
  const destinationRef = useRef<PlaceSelection | null>(null);
  const routeRef = useRef<RouteResult | null>(null);
  const routePathRef = useRef<google.maps.LatLngLiteral[]>([]);
  const routeCumulativeRef = useRef<number[]>([]);
  const lastMatchedSegmentIndexRef = useRef<number | null>(null);
  const lastMatchedProgressMetersRef = useRef(0);
  const lastMatchedPointRef = useRef<google.maps.LatLngLiteral | null>(null);
  const navigationActiveRef = useRef(false);
  const rerouteInFlightRef = useRef(false);
  const lastRerouteAtRef = useRef(0);
  const offRouteCountRef = useRef(0);
  const lastOffRouteDistanceRef = useRef(0);
  const arrivalConfirmCountRef = useRef(0);
  const arrivalClearTimerRef = useRef<number | null>(null);

  const [theme] = useState<ThemeMode>(() => readTheme());
  const [gpsState, setGpsState] = useState<GpsState>("loading");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [destination, setDestination] = useState<PlaceSelection | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [navigationActive, setNavigationActive] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [remainingDistanceMeters, setRemainingDistanceMeters] = useState<number | null>(null);
  const [remainingDurationSeconds, setRemainingDurationSeconds] = useState<number | null>(null);
  const [arrivalState, setArrivalState] = useState<ArrivalState>("none");

  const updateFollowCamera = (
    map: google.maps.Map,
    point: google.maps.LatLngLiteral,
    heading: number | null,
    speedMetersPerSecond: number,
    force = false
  ) => {
    if (!followLocationRef.current) return;

    const now = performance.now();
    if (!force && now - lastCameraUpdateRef.current < CAMERA_UPDATE_MIN_MS) return;
    lastCameraUpdateRef.current = now;

    if (!didInitialZoomRef.current) {
      if ((map.getZoom() ?? 0) < 16) map.setZoom(16);
      didInitialZoomRef.current = true;
    }

    const canRotate = vectorHeadingRef.current && heading !== null;
    const currentZoom = map.getZoom() ?? 16;

    if (canRotate) {
      const lookAheadMeters = clamp(45 + speedMetersPerSecond * 4, 45, 115);
      const cameraCenter = destinationPoint(point, heading, lookAheadMeters);

      map.moveCamera({
        center: cameraCenter,
        zoom: currentZoom,
        heading,
        tilt: 0
      });
    } else {
      map.moveCamera({
        center: point,
        zoom: currentZoom,
        heading: 0,
        tilt: 0
      });
    }
  };

  const drawRoute = (
    map: google.maps.Map,
    routeData: RouteResult,
    origin: google.maps.LatLngLiteral,
    destinationPointValue: google.maps.LatLngLiteral,
    fitPreview: boolean
  ) => {
    const overviewPath = decodePolyline(routeData.encodedPolyline);
    const routePath = buildDetailedRoutePath(routeData);
    const cumulative = buildCumulativeDistances(routePath);

    routeRef.current = routeData;
    routePathRef.current = routePath;
    routeCumulativeRef.current = cumulative;
    lastMatchedSegmentIndexRef.current = null;
    lastMatchedProgressMetersRef.current = 0;
    lastMatchedPointRef.current = null;
    setRoute(routeData);
    setRemainingDistanceMeters(routeData.distanceMeters);
    setRemainingDurationSeconds(routeData.durationSeconds);

    if (!routePolylineRef.current) {
      routePolylineRef.current = new google.maps.Polyline({
        map,
        path: overviewPath,
        clickable: false,
        geodesic: false,
        strokeColor: "#2563EB",
        strokeOpacity: 0.95,
        strokeWeight: 6,
        zIndex: 7
      });
    } else {
      routePolylineRef.current.setMap(map);
      routePolylineRef.current.setPath(overviewPath);
      routePolylineRef.current.setOptions({
        strokeColor: "#2563EB",
        strokeOpacity: 0.95,
        strokeWeight: navigationActiveRef.current ? 7 : 6
      });
    }

    if (fitPreview) {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(origin);
      bounds.extend(destinationPointValue);
      for (const routePoint of overviewPath) bounds.extend(routePoint);

      followLocationRef.current = false;
      map.fitBounds(bounds, {
        top: 80,
        right: 70,
        bottom: 110,
        left: 70
      });
      map.setTilt(0);
      map.setHeading(0);
    }
  };

  const requestRoute = async (
    origin: google.maps.LatLngLiteral,
    destinationValue: PlaceSelection,
    fitPreview: boolean
  ) => {
    const response = await fetch("/api/v1/routes/compute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        origin,
        destination: destinationValue.location
      })
    });

    if (!response.ok) {
      throw new Error("Route request failed");
    }

    const routeData = (await response.json()) as RouteResult;
    const map = mapRef.current;

    if (!map) {
      throw new Error("Map is not ready");
    }

    drawRoute(map, routeData, origin, destinationValue.location, fitPreview);
    return routeData;
  };

  const rerouteFrom = async (origin: google.maps.LatLngLiteral) => {
    const destinationValue = destinationRef.current;
    const now = Date.now();

    if (
      !navigationActiveRef.current ||
      !destinationValue ||
      rerouteInFlightRef.current ||
      now - lastRerouteAtRef.current < REROUTE_COOLDOWN_MS
    ) {
      return;
    }

    rerouteInFlightRef.current = true;
    lastRerouteAtRef.current = now;
    offRouteCountRef.current = 0;
    lastOffRouteDistanceRef.current = 0;
    setRerouting(true);
    setRouteError(null);

    try {
      await requestRoute(origin, destinationValue, false);
      const map = mapRef.current;

      if (map) {
        followLocationRef.current = true;
        const rerouteMatch = matchPointToRoute(
          origin,
          routePathRef.current,
          routeCumulativeRef.current,
          null,
          0,
          Math.max(accuracy ?? 30, 1)
        );

        if (rerouteMatch) {
          lastMatchedSegmentIndexRef.current = rerouteMatch.segmentIndex;
          lastMatchedProgressMetersRef.current = rerouteMatch.progressMeters;
          lastMatchedPointRef.current = rerouteMatch.snappedPoint;
          routeHeadingRef.current = rerouteMatch.heading;
        }

        const heading =
          rerouteMatch?.heading ??
          routeHeadingForPoint(origin, routePathRef.current) ??
          routeHeadingRef.current ??
          smoothedHeadingRef.current;

        if (heading !== null) {
          routeHeadingRef.current = heading;
        }

        updateFollowCamera(
          map,
          rerouteMatch?.snappedPoint ?? origin,
          heading,
          lastSpeedRef.current,
          true
        );
      }
    } catch {
      setRouteError("Reroute failed");
    } finally {
      rerouteInFlightRef.current = false;
      setRerouting(false);
    }
  };

  const completeArrival = () => {
    if (!navigationActiveRef.current) return;

    navigationActiveRef.current = false;
    routeHeadingRef.current = null;
    rerouteInFlightRef.current = false;
    offRouteCountRef.current = 0;
    lastOffRouteDistanceRef.current = 0;
    arrivalConfirmCountRef.current = 0;

    setNavigationActive(false);
    setRerouting(false);
    setArrivalState("arrived");
    setRouteError(null);
    setRemainingDistanceMeters(0);
    setRemainingDurationSeconds(0);

    followLocationRef.current = false;

    routePolylineRef.current?.setMap(null);
    routePathRef.current = [];
    routeCumulativeRef.current = [];
    lastMatchedSegmentIndexRef.current = null;
    lastMatchedProgressMetersRef.current = 0;
    lastMatchedPointRef.current = null;
    routeRef.current = null;
    setRoute(null);

    if (arrivalClearTimerRef.current !== null) {
      window.clearTimeout(arrivalClearTimerRef.current);
    }

    arrivalClearTimerRef.current = window.setTimeout(() => {
      destinationMarkerRef.current?.setMap(null);
      destinationMarkerRef.current = null;
      destinationRef.current = null;

      setDestination(null);
      setSearchQuery("");
      setRouteError(null);
      setArrivalState("none");

      arrivalClearTimerRef.current = null;
    }, ARRIVAL_NOTICE_MS);
  };

  const updateNavigationProgress = (
    rawPoint: google.maps.LatLngLiteral,
    positionAccuracy: number,
    speedMetersPerSecond: number,
    matched: RouteMatch | null
  ) => {
    if (!navigationActiveRef.current) return;

    const routeData = routeRef.current;
    const routePath = routePathRef.current;

    if (!routeData || routePath.length < 2) return;

    const progress =
      matched ??
      routeProgress(rawPoint, routePath);

    if (!progress) return;

    const geometryRatio =
      progress.totalGeometryMeters > 0
        ? clamp(
            progress.remainingGeometryMeters / progress.totalGeometryMeters,
            0,
            1
          )
        : 1;

    const now = performance.now();
    if (now - lastProgressUiUpdateRef.current >= PROGRESS_UI_MIN_MS) {
      lastProgressUiUpdateRef.current = now;
      setRemainingDistanceMeters(routeData.distanceMeters * geometryRatio);
      setRemainingDurationSeconds(routeData.durationSeconds * geometryRatio);
    }

    const standardThreshold = Math.min(
      35,
      Math.max(10, positionAccuracy * 1.2, speedMetersPerSecond * 0.6)
    );

    const poorGps = positionAccuracy > POOR_GPS_ACCURACY_METERS;
    const effectiveThreshold = poorGps
      ? Math.max(120, positionAccuracy * 1.2)
      : standardThreshold;

    const destinationValue = destinationRef.current;

    if (destinationValue) {
      const directDistanceToDestination = distanceMeters(
        rawPoint,
        destinationValue.location
      );

      const arrivingThreshold = poorGps
        ? Math.max(
            ARRIVING_ROUTE_METERS,
            Math.min(positionAccuracy * 1.2, 260)
          )
        : ARRIVING_ROUTE_METERS;

      const arrivedDirectThreshold = poorGps
        ? clamp(positionAccuracy * 0.65, 55, 90)
        : clamp(positionAccuracy * 0.8, 35, 60);

      const arrivedRouteThreshold = poorGps
        ? clamp(positionAccuracy * 0.65, 70, 100)
        : 45;

      const nearArrival =
        progress.remainingGeometryMeters <= arrivingThreshold ||
        directDistanceToDestination <= arrivingThreshold;

      if (nearArrival && arrivalState !== "arrived") {
        setArrivalState("arriving");
      } else if (!nearArrival && arrivalState === "arriving") {
        setArrivalState("none");
      }

      const arrivalConfirmed =
        progress.remainingGeometryMeters <= arrivedRouteThreshold &&
        directDistanceToDestination <= arrivedDirectThreshold &&
        progress.distanceFromRouteMeters <=
          Math.max(effectiveThreshold, arrivedDirectThreshold) &&
        speedMetersPerSecond <= 10;

      if (arrivalConfirmed) {
        arrivalConfirmCountRef.current += 1;
      } else {
        arrivalConfirmCountRef.current = 0;
      }

      if (arrivalConfirmCountRef.current >= ARRIVAL_CONFIRM_FIXES) {
        completeArrival();
        return;
      }
    }

    if (progress.distanceFromRouteMeters <= effectiveThreshold) {
      offRouteCountRef.current = 0;
      lastOffRouteDistanceRef.current = progress.distanceFromRouteMeters;
      return;
    }

    const grossDeviation = poorGps
      ? progress.distanceFromRouteMeters >
        Math.max(180, positionAccuracy * 1.5)
      : progress.distanceFromRouteMeters >
        Math.max(60, standardThreshold * 2.5);

    const diverging =
      offRouteCountRef.current >= 1 &&
      progress.distanceFromRouteMeters >
        lastOffRouteDistanceRef.current + 8;

    offRouteCountRef.current += 1;
    lastOffRouteDistanceRef.current = progress.distanceFromRouteMeters;

    if (grossDeviation || diverging || offRouteCountRef.current >= 2) {
      void rerouteFrom(rawPoint);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let watchId: number | null = null;

    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_API_KEY?.trim();
    const mapId = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID?.trim();

    if (!apiKey) {
      setMapError("Google Maps browser key is missing.");
      return;
    }

    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !mapElementRef.current) return;

        const map = new google.maps.Map(mapElementRef.current, {
          center: TBILISI,
          ...(mapId ? { mapId } : {}),
          zoom: 13,
          mapTypeId: google.maps.MapTypeId.ROADMAP,
          renderingType: google.maps.RenderingType.VECTOR,
          colorScheme:
            theme === "dark"
              ? google.maps.ColorScheme.DARK
              : google.maps.ColorScheme.LIGHT,
          tilt: 0,
          heading: 0,
          tiltInteractionEnabled: false,
          headingInteractionEnabled: false,
          disableDefaultUI: true,
          gestureHandling: "greedy",
          keyboardShortcuts: false,
          clickableIcons: false,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          zoomControl: false
        });

        mapRef.current = map;

        google.maps.event.addListenerOnce(map, "tilesloaded", () => {
          vectorHeadingRef.current =
            map.getRenderingType() === google.maps.RenderingType.VECTOR;
        });

        map.addListener("tilt_changed", () => {
          if ((map.getTilt() ?? 0) !== 0) map.setTilt(0);
        });

        map.addListener("dragstart", () => {
          followLocationRef.current = false;
        });

        if (!navigator.geolocation) {
          setGpsState("unavailable");
          return;
        }

        watchId = navigator.geolocation.watchPosition(
          (position) => {
            const point = {
              lat: position.coords.latitude,
              lng: position.coords.longitude
            };
            const positionAccuracy = Math.max(position.coords.accuracy || 0, 1);
            const speed = Math.max(position.coords.speed ?? 0, 0);
            const previousSample = previousSampleRef.current;

            let rawHeading: number | null = null;

            if (
              Number.isFinite(position.coords.heading) &&
              position.coords.heading !== null &&
              speed >= 1.5
            ) {
              rawHeading = normalizeHeading(position.coords.heading);
            } else if (previousSample) {
              const moved = distanceMeters(previousSample.point, point);
              const requiredMovement = Math.max(
                MIN_BEARING_DISTANCE_METERS,
                Math.min(positionAccuracy * 0.25, 25)
              );

              if (moved >= requiredMovement) {
                rawHeading = bearingDegrees(previousSample.point, point);
              }
            }

            if (rawHeading !== null) {
              smoothedHeadingRef.current = smoothHeading(
                smoothedHeadingRef.current,
                rawHeading
              );
            }

            lastPositionRef.current = point;
            previousSampleRef.current = {
              point,
              timestamp: position.timestamp
            };
            lastSpeedRef.current = speed;

            setAccuracy(Math.round(positionAccuracy));
            setGpsState("live");

            if (!accuracyCircleRef.current) {
              accuracyCircleRef.current = new google.maps.Circle({
                map,
                center: point,
                radius: positionAccuracy,
                clickable: false,
                strokeColor: "#3B82F6",
                strokeWeight: 1,
                strokeOpacity: 0.28,
                fillColor: "#60A5FA",
                fillOpacity: 0.09,
                zIndex: 1
              });
            } else {
              accuracyCircleRef.current.setCenter(point);
              accuracyCircleRef.current.setRadius(positionAccuracy);
            }

            const gpsHeading = smoothedHeadingRef.current;
            let cameraHeading = gpsHeading;
            let visualPoint = point;
            let matched: RouteMatch | null = null;

            if (
              navigationActiveRef.current &&
              routePathRef.current.length >= 2 &&
              routeCumulativeRef.current.length === routePathRef.current.length
            ) {
              matched = matchPointToRoute(
                point,
                routePathRef.current,
                routeCumulativeRef.current,
                lastMatchedSegmentIndexRef.current,
                lastMatchedProgressMetersRef.current,
                positionAccuracy
              );

              if (matched) {
                const snapThreshold = Math.min(
                  180,
                  Math.max(35, positionAccuracy * 1.25)
                );

                if (matched.distanceFromRouteMeters <= snapThreshold) {
                  lastMatchedSegmentIndexRef.current = matched.segmentIndex;
                  lastMatchedProgressMetersRef.current = Math.max(
                    lastMatchedProgressMetersRef.current,
                    matched.progressMeters
                  );
                  lastMatchedPointRef.current = matched.snappedPoint;
                  visualPoint = matched.snappedPoint;

                  routeHeadingRef.current = smoothHeading(
                    routeHeadingRef.current,
                    matched.heading,
                    0.45
                  );
                  cameraHeading = routeHeadingRef.current;
                }
              }
            }

            const showDirection =
              (navigationActiveRef.current && cameraHeading !== null) ||
              (gpsHeading !== null && speed >= 1.5);

            const markerHeading =
              navigationActiveRef.current && vectorHeadingRef.current
                ? 0
                : cameraHeading ?? 0;

            const markerIcon = showDirection
              ? navigationArrowIcon(markerHeading)
              : locationDotIcon();

            if (!locationMarkerRef.current) {
              locationMarkerRef.current = new google.maps.Marker({
                map,
                position: visualPoint,
                clickable: false,
                optimized: true,
                icon: markerIcon,
                zIndex: 10
              });
            } else {
              locationMarkerRef.current.setPosition(visualPoint);
              locationMarkerRef.current.setIcon(markerIcon);
            }

            updateFollowCamera(
              map,
              visualPoint,
              cameraHeading,
              speed
            );

            updateNavigationProgress(
              point,
              positionAccuracy,
              speed,
              matched
            );
          },
          (error) => {
            if (error.code === error.PERMISSION_DENIED) {
              setGpsState("denied");
            } else if (error.code === error.POSITION_UNAVAILABLE) {
              setGpsState("unavailable");
            } else {
              setGpsState("error");
            }
          },
          {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 12000
          }
        );
      })
      .catch(() => {
        if (!cancelled) setMapError("Google Maps could not be loaded.");
      });

    return () => {
      cancelled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      locationMarkerRef.current?.setMap(null);
      destinationMarkerRef.current?.setMap(null);
      routePolylineRef.current?.setMap(null);
      accuracyCircleRef.current?.setMap(null);

      if (arrivalClearTimerRef.current !== null) {
        window.clearTimeout(arrivalClearTimerRef.current);
      }
    };
  }, [theme]);

  useEffect(() => {
    if (!searchOpen) return;

    const query = searchQuery.trim();

    if (query.length < 2) {
      setSuggestions([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    const controller = new AbortController();

    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);

      try {
        const location = lastPositionRef.current;

        const response = await fetch("/api/v1/places/autocomplete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          signal: controller.signal,
          body: JSON.stringify({
            input: query,
            sessionToken: searchSessionTokenRef.current,
            ...(location
              ? {
                  lat: location.lat,
                  lng: location.lng
                }
              : {})
          })
        });

        if (!response.ok) {
          throw new Error("Search request failed");
        }

        const data = (await response.json()) as {
          suggestions?: PlaceSuggestion[];
        };

        setSuggestions(data.suggestions ?? []);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSuggestions([]);
        setSearchError("Search is temporarily unavailable");
      } finally {
        if (!controller.signal.aborted) {
          setSearchLoading(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchOpen, searchQuery]);

  const selectSuggestion = async (suggestion: PlaceSuggestion) => {
    const map = mapRef.current;
    if (!map) return;

    if (arrivalClearTimerRef.current !== null) {
      window.clearTimeout(arrivalClearTimerRef.current);
      arrivalClearTimerRef.current = null;
    }

    arrivalConfirmCountRef.current = 0;
    setArrivalState("none");
    setSearchLoading(true);
    setSearchError(null);
    setRouteError(null);

    try {
      const response = await fetch(
        `/api/v1/places/${encodeURIComponent(suggestion.placeId)}?sessionToken=${encodeURIComponent(searchSessionTokenRef.current)}`
      );

      if (!response.ok) {
        throw new Error("Place details request failed");
      }

      const selected = (await response.json()) as PlaceSelection;

      destinationMarkerRef.current?.setMap(null);
      destinationMarkerRef.current = new google.maps.Marker({
        map,
        position: selected.location,
        clickable: false,
        optimized: true,
        icon: destinationIcon(),
        zIndex: 9
      });

      destinationRef.current = selected;
      setDestination(selected);
      setSearchQuery(selected.name);
      setSuggestions([]);
      setSearchOpen(false);
      searchSessionTokenRef.current = createSearchSessionToken();

      const origin = lastPositionRef.current;

      if (!origin) {
        followLocationRef.current = false;
        map.moveCamera({
          center: selected.location,
          zoom: Math.max(map.getZoom() ?? 15, 15),
          heading: 0,
          tilt: 0
        });
        routeRef.current = null;
        routePathRef.current = [];
        routeCumulativeRef.current = [];
        lastMatchedSegmentIndexRef.current = null;
        lastMatchedProgressMetersRef.current = 0;
        lastMatchedPointRef.current = null;
        setRoute(null);
        setRouteError("Waiting for GPS before calculating route");
        return;
      }

      setRouteLoading(true);
      await requestRoute(origin, selected, true);
    } catch {
      setSearchError("Could not open this destination");
      setRouteError("Route is temporarily unavailable");
    } finally {
      setSearchLoading(false);
      setRouteLoading(false);
    }
  };

  const openSearch = () => {
    if (navigationActiveRef.current) return;

    setSearchOpen(true);
    setSearchError(null);

    if (destination && !searchQuery) {
      setSearchQuery(destination.name);
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSuggestions([]);
    setSearchError(null);
  };

  const startNavigation = () => {
    const map = mapRef.current;
    const point = lastPositionRef.current;

    if (!map || !point || !routeRef.current || !destinationRef.current) return;

    if (arrivalClearTimerRef.current !== null) {
      window.clearTimeout(arrivalClearTimerRef.current);
      arrivalClearTimerRef.current = null;
    }

    arrivalConfirmCountRef.current = 0;
    setArrivalState("none");
    navigationActiveRef.current = true;
    const initialMatch = matchPointToRoute(
      point,
      routePathRef.current,
      routeCumulativeRef.current,
      null,
      0,
      Math.max(accuracy ?? 30, 1)
    );

    if (initialMatch) {
      lastMatchedSegmentIndexRef.current = initialMatch.segmentIndex;
      lastMatchedProgressMetersRef.current = initialMatch.progressMeters;
      lastMatchedPointRef.current = initialMatch.snappedPoint;
      routeHeadingRef.current = initialMatch.heading;
    } else {
      routeHeadingRef.current = routeHeadingForPoint(
        point,
        routePathRef.current
      );
    }
    setNavigationActive(true);
    setSearchOpen(false);
    setRouteError(null);
    followLocationRef.current = true;
    offRouteCountRef.current = 0;
    lastOffRouteDistanceRef.current = 0;
    didInitialZoomRef.current = true;

    if ((map.getZoom() ?? 0) < 17) {
      map.setZoom(17);
    }

    routePolylineRef.current?.setOptions({
      strokeWeight: 7,
      strokeOpacity: 1
    });

    updateFollowCamera(
      map,
      initialMatch?.snappedPoint ?? point,
      routeHeadingRef.current ?? smoothedHeadingRef.current,
      lastSpeedRef.current,
      true
    );
  };

  const endNavigation = () => {
    navigationActiveRef.current = false;
    routeHeadingRef.current = null;
    arrivalConfirmCountRef.current = 0;
    setArrivalState("none");
    setNavigationActive(false);
    setRerouting(false);
    offRouteCountRef.current = 0;
    lastOffRouteDistanceRef.current = 0;
    followLocationRef.current = false;

    routePolylineRef.current?.setOptions({
      strokeWeight: 6,
      strokeOpacity: 0.95
    });
  };

  const recenter = () => {
    const map = mapRef.current;
    const point = lastPositionRef.current;

    followLocationRef.current = true;

    if (map && point) {
      const heading =
        navigationActiveRef.current && routePathRef.current.length >= 2
          ? routeHeadingForPoint(point, routePathRef.current) ??
            routeHeadingRef.current ??
            smoothedHeadingRef.current
          : smoothedHeadingRef.current;

      if (navigationActiveRef.current && heading !== null) {
        routeHeadingRef.current = heading;
      }

      updateFollowCamera(
        map,
        navigationActiveRef.current
          ? lastMatchedPointRef.current ?? point
          : point,
        heading,
        lastSpeedRef.current,
        true
      );
    }
  };

  const zoomBy = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;

    map.setTilt(0);
    map.setZoom(Math.max(2, Math.min(21, (map.getZoom() ?? 13) + delta)));
  };

  const toggleTheme = () => {
    const nextTheme: ThemeMode = theme === "light" ? "dark" : "light";

    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Storage may be unavailable in restricted browser modes.
    }

    window.location.reload();
  };

  const gpsQuality =
    accuracy === null ? "unknown" : accuracy <= 35 ? "good" : accuracy <= 80 ? "fair" : "poor";

  const gpsLabel =
    gpsState === "live"
      ? accuracy
        ? `GPS ${accuracy}m`
        : "GPS"
      : gpsState === "loading"
        ? "GPS…"
        : gpsState === "denied"
          ? "GPS blocked"
          : gpsState === "unavailable"
            ? "GPS unavailable"
            : "GPS error";

  const displayedDistance =
    navigationActive && remainingDistanceMeters !== null
      ? remainingDistanceMeters
      : route?.distanceMeters ?? null;

  const displayedDuration =
    navigationActive && remainingDurationSeconds !== null
      ? remainingDurationSeconds
      : route?.durationSeconds ?? null;

  const activeStep = navigationActive
    ? currentRouteStep(route, remainingDistanceMeters)
    : null;

  return (
    <main className="map-shell" data-theme={theme}>
      <div ref={mapElementRef} className="map-canvas" />

      <div className="status-pill" data-state={gpsState} data-quality={gpsQuality}>
        <span className="status-dot" />
        {gpsLabel}
      </div>

      {arrivalState === "arrived" ? (
        <section className="turn-card arrival-card" aria-live="assertive">
          <span className="turn-icon arrival-icon" aria-hidden="true">✓</span>
          <span className="turn-copy">
            <strong>You have arrived</strong>
            <small>{destination?.name ?? "Destination"}</small>
          </span>
        </section>
      ) : navigationActive && arrivalState === "arriving" ? (
        <section className="turn-card arrival-card" aria-live="polite">
          <span className="turn-icon arrival-icon" aria-hidden="true">⚑</span>
          <span className="turn-copy">
            <strong>Arriving</strong>
            <small>{destination?.name ?? "Destination"}</small>
          </span>
        </section>
      ) : navigationActive && activeStep ? (
        <section className="turn-card" aria-live="polite">
          <span className="turn-icon" aria-hidden="true">
            {maneuverIcon(activeStep.maneuver)}
          </span>
          <span className="turn-copy">
            <strong>{formatDistance(activeStep.distanceToManeuverMeters)}</strong>
            <small title={activeStep.instruction}>{activeStep.instruction}</small>
          </span>
        </section>
      ) : null}

      {!navigationActive && !searchOpen ? (
        <button className="search-launch-button" type="button" onClick={openSearch} aria-label="Search destination">
          ⌕
        </button>
      ) : !navigationActive && searchOpen ? (
        <section className="search-panel">
          <div className="search-box">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search destination"
              spellCheck={false}
              autoComplete="off"
            />
            {searchLoading ? (
              <span className="search-spinner" aria-label="Searching" />
            ) : (
              <button className="search-close-button" type="button" onClick={closeSearch} aria-label="Close search">
                ×
              </button>
            )}
          </div>

          {(suggestions.length > 0 || searchError) && (
            <div className="search-results">
              {searchError ? (
                <div className="search-message">{searchError}</div>
              ) : (
                suggestions.map((suggestion) => (
                  <button
                    className="search-result"
                    key={suggestion.placeId}
                    type="button"
                    onClick={() => selectSuggestion(suggestion)}
                  >
                    <span className="search-result-pin">●</span>
                    <span className="search-result-copy">
                      <strong>{suggestion.mainText}</strong>
                      <small>{suggestion.secondaryText || suggestion.fullText}</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </section>
      ) : null}

      {destination && !searchOpen && !navigationActive && (
        <button className="destination-chip" type="button" onClick={openSearch}>
          <span className="destination-dot" />
          <span className="destination-copy">
            <strong>{destination.name}</strong>
            {destination.address && <small>{destination.address}</small>}
          </span>
        </button>
      )}

      {destination && !searchOpen && (
        <section className="route-summary" data-navigation={navigationActive ? "active" : "preview"} aria-live="polite">
          {routeLoading ? (
            <span>Calculating route…</span>
          ) : route && displayedDuration !== null && displayedDistance !== null ? (
            <>
              <div className="route-stats">
                <strong>{rerouting ? "Rerouting…" : formatDuration(displayedDuration)}</strong>
                <span>{formatDistance(displayedDistance)}</span>
              </div>
              <button
                className={navigationActive ? "route-action route-action-end" : "route-action"}
                type="button"
                onClick={navigationActive ? endNavigation : startNavigation}
              >
                {navigationActive ? "End" : "Start"}
              </button>
            </>
          ) : routeError ? (
            <span>{routeError}</span>
          ) : null}
        </section>
      )}

      <div className="map-controls map-controls-right">
        <button className="map-button" type="button" onClick={() => zoomBy(1)} aria-label="Zoom in">
          +
        </button>
        <button className="map-button" type="button" onClick={() => zoomBy(-1)} aria-label="Zoom out">
          −
        </button>
      </div>

      <button
        className="theme-button"
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "light" ? "Switch to dark map" : "Switch to light map"}
      >
        {theme === "light" ? "☾" : "☀"}
      </button>

      <button className="location-button" type="button" onClick={recenter} aria-label="Follow my location">
        <span className="location-icon" aria-hidden="true">⌖</span>
      </button>

      {mapError && (
        <section className="map-error">
          <strong>Map unavailable</strong>
          <span>{mapError}</span>
        </section>
      )}
    </main>
  );
}
