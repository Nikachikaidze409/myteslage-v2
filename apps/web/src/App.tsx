import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "./googleMaps";

type GpsState = "loading" | "live" | "denied" | "unavailable" | "error";
type ThemeMode = "light" | "dark";

type PositionSample = {
  point: google.maps.LatLngLiteral;
  timestamp: number;
};

const TBILISI = { lat: 41.7151, lng: 44.8271 };
const THEME_STORAGE_KEY = "tmap-theme";
const CAMERA_UPDATE_MIN_MS = 250;
const MIN_BEARING_DISTANCE_METERS = 8;

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

function readTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export default function App() {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const locationDotRef = useRef<google.maps.Circle | null>(null);
  const accuracyCircleRef = useRef<google.maps.Circle | null>(null);
  const lastPositionRef = useRef<google.maps.LatLngLiteral | null>(null);
  const previousSampleRef = useRef<PositionSample | null>(null);
  const smoothedHeadingRef = useRef<number | null>(null);
  const lastSpeedRef = useRef(0);
  const lastCameraUpdateRef = useRef(0);
  const followLocationRef = useRef(true);
  const vectorHeadingRef = useRef(true);
  const didInitialZoomRef = useRef(false);

  const [theme] = useState<ThemeMode>(() => readTheme());
  const [gpsState, setGpsState] = useState<GpsState>("loading");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

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
                strokeWeight: 1,
                strokeOpacity: 0.18,
                fillOpacity: 0.08
              });
            } else {
              accuracyCircleRef.current.setCenter(point);
              accuracyCircleRef.current.setRadius(positionAccuracy);
            }

            if (!locationDotRef.current) {
              locationDotRef.current = new google.maps.Circle({
                map,
                center: point,
                radius: 7,
                clickable: false,
                strokeWeight: 3,
                strokeOpacity: 1,
                fillOpacity: 1,
                zIndex: 2
              });
            } else {
              locationDotRef.current.setCenter(point);
            }

            updateFollowCamera(
              map,
              point,
              smoothedHeadingRef.current,
              speed
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
      locationDotRef.current?.setMap(null);
      accuracyCircleRef.current?.setMap(null);
    };
  }, [theme]);

  const recenter = () => {
    const map = mapRef.current;
    const point = lastPositionRef.current;

    followLocationRef.current = true;

    if (map && point) {
      updateFollowCamera(
        map,
        point,
        smoothedHeadingRef.current,
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

  return (
    <main className="map-shell" data-theme={theme}>
      <div ref={mapElementRef} className="map-canvas" />

      <div className="status-pill" data-state={gpsState} data-quality={gpsQuality}>
        <span className="status-dot" />
        {gpsLabel}
      </div>

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
