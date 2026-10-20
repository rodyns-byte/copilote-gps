import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { bearing, dist, type LngLat } from '../lib/geo';

export type Fix = { coord: LngLat; heading: number; speed: number; at: number };

/** Suit la position GPS en continu (premier plan). */
export function useLocation(onFix?: (f: Fix) => void) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [denied, setDenied] = useState(false);
  const last = useRef<Fix | null>(null);
  const cb = useRef(onFix);
  cb.current = onFix;

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return setDenied(true);
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 3 },
        (p) => {
          const coord: LngLat = [p.coords.longitude, p.coords.latitude];
          const speed = p.coords.speed ?? 0;
          const prev = last.current;
          let heading = prev?.heading ?? 0;
          if (p.coords.heading != null && p.coords.heading >= 0 && speed > 1) heading = p.coords.heading;
          else if (prev && dist(prev.coord, coord) > 8) heading = bearing(prev.coord, coord);
          const f = { coord, heading, speed, at: p.timestamp };
          last.current = f;
          setFix(f);
          cb.current?.(f);
        },
      );
    })();
    return () => sub?.remove();
  }, []);

  return { fix, denied };
}
