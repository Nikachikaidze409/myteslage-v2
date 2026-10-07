let googleMapsPromise: Promise<typeof google> | null = null;

type GoogleMapsCallbackWindow = Window &
  typeof globalThis & {
    __tmapGoogleMapsReady?: () => void;
  };

export function loadGoogleMaps(apiKey: string): Promise<typeof google> {
  if (window.google?.maps) {
    return Promise.resolve(window.google);
  }

  if (googleMapsPromise) {
    return googleMapsPromise;
  }

  googleMapsPromise = new Promise((resolve, reject) => {
    const callbackWindow = window as GoogleMapsCallbackWindow;
    const callbackName = "__tmapGoogleMapsReady";

    callbackWindow.__tmapGoogleMapsReady = () => {
      resolve(window.google);
      delete callbackWindow.__tmapGoogleMapsReady;
    };

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: apiKey,
      callback: callbackName,
      v: "weekly"
    });

    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      googleMapsPromise = null;
      reject(new Error("Google Maps failed to load."));
    };

    document.head.appendChild(script);
  });

  return googleMapsPromise;
}
