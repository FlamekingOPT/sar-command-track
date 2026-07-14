import { useEffect, useState, useCallback } from 'react';
import { enqueue, allEntries } from './offlineQueue';

export function useGpsTracking(enabled, linkKey) {
  const [position, setPosition] = useState(null);
  const [points, setPoints] = useState([]);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  // Reload the full path from IndexedDB once, so the line never resets
  // when the tab is reopened mid-search (spec §6) — but only points from THIS
  // assignment, or a prior search's track would draw on the current zone.
  useEffect(() => {
    if (!linkKey) return;
    allEntries().then(entries => {
      const prior = entries
        .filter(e => e.type === 'trackPoint' && e.linkKey === linkKey)
        .map(e => e.payload);
      if (prior.length) setPoints(prev => [...prior, ...prev]);
    });
  }, [linkKey]);

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      setError('unsupported');
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      pos => {
        setError(null);
        const point = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          timestamp: Date.now(),
        };
        setPosition(point);
        setPoints(prev => [...prev, point]);
        enqueue('trackPoint', point, linkKey);
      },
      err => setError(err.code === 1 ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [enabled, attempt, linkKey]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  return { position, points, error, retry };
}
