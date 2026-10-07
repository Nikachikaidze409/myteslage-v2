import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "./googleMaps";

type GpsState = "loading" | "live" | "denied" | "unavailable" | "error";

const TBILISI = { lat: 41.7151, lng: 44.8271 };

export default function App() {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const locationDotRef = useRef<google.maps.Circle | null>(null);
  const accuracyCircleRef = useRef<google.maps.Circle | null>(null);
  const lastPositionRef = useRef<google.maps.LatLngLiteral | null>(null);
  const followLocationRef = useRef(true);

  const [gpsState, setGpsState] = useState<GpsState>("loading");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

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
          renderingType: google.maps.RenderingType.RASTER,
          tilt: 0,
          heading: 0,
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

        // Keep the map permanently flat/top-down.
        map.addListener("tilt_changed", () => {
          if ((map.getTilt() ?? 0) !== 0) map.setTilt(0);
        });

        map.addListener("heading_changed", () => {
          if ((map.getHeading() ?? 0) !== 0) map.setHeading(0);
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

            lastPositionRef.current = point;
            setAccuracy(Math.round(positionAccuracy));
            setGpsState("live");

            if (!accuracyCircleRef.current) {
              accuracyCircleRef.current = new google.maps.Circle({
                map,
                center: point,
                radius: positionAccuracy,
                clickable: false,
                strokeWeight: 1,
                strokeOpacity: 0.2,
                fillOpacity: 0.1
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

            if (followLocationRef.current) {
              map.panTo(point);
              if ((map.getZoom() ?? 0) < 16) map.setZoom(16);
            }
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
  }, []);

  const recenter = () => {
    const map = mapRef.current;
    const point = lastPositionRef.current;

    followLocationRef.current = true;

    if (map && point) {
      map.setTilt(0);
      map.setHeading(0);
      map.panTo(point);
      if ((map.getZoom() ?? 0) < 16) map.setZoom(16);
    }
  };

  const zoomBy = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;

    map.setTilt(0);
    map.setHeading(0);
    map.setZoom(Math.max(2, Math.min(21, (map.getZoom() ?? 13) + delta)));
  };

  const gpsLabel =
    gpsState === "live"
      ? accuracy
        ? `GPS accuracy ±${accuracy}m`
        : "GPS live"
      : gpsState === "loading"
        ? "Finding location…"
        : gpsState === "denied"
          ? "Location blocked"
          : gpsState === "unavailable"
            ? "GPS unavailable"
            : "GPS error";

  return (
    <main className="map-shell">
      <div ref={mapElementRef} className="map-canvas" />

      <div className="status-pill" data-state={gpsState}>
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

      <button className="location-button" type="button" onClick={recenter}>
        <span className="location-icon" aria-hidden="true">⌖</span>
        My Location
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
