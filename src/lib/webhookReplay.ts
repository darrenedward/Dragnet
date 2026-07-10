/**
 * Webhook replay protection — in-memory cache of seen delivery GUIDs.
 *
 * GitHub sends an `x-github-delivery` GUID with each webhook delivery.
 * We cache seen GUIDs for DELIVERY_TTL_MS to reject duplicate deliveries
 * (replay attacks / accidental retries).
 *
 * This is an in-memory Map, so it resets on server restart. That's
 * acceptable — replay protection is best-effort; a restart invalidates
 * the cache and the worst case is one extra scan per duplicate delivery.
 */

const DELIVERY_TTL_MS = 300_000; // 5 minutes

const seen = new Map<string, number>();

/**
 * Returns true if this delivery GUID has been seen within the TTL window.
 * If not seen, records it and returns false.
 */
export function checkDelivery(deliveryGuid: string): boolean {
  const now = Date.now();
  // Purge stale entries opportunistically (per-call, not a timer).
  for (const [key, ts] of seen) {
    if (now - ts > DELIVERY_TTL_MS) seen.delete(key);
  }
  if (seen.has(deliveryGuid)) return true;
  seen.set(deliveryGuid, now);
  return false;
}
