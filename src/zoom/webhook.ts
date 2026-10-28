import { createHmac, timingSafeEqual } from 'node:crypto';

// Ported from zoom/rtms-samples library/javascript/webhookManager/zoomWebhookSignature.js.

/** Response to Zoom's `endpoint.url_validation` challenge. */
export function urlValidationResponse(plainToken: string, secretToken: string) {
  return { plainToken, encryptedToken: createHmac('sha256', secretToken).update(plainToken).digest('hex') };
}

/** Checks `x-zm-signature` (`v0=HMAC(secret, "v0:{timestamp}:{rawBody}")`) and rejects stale timestamps. */
export function verifyWebhook(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secretToken: string,
  nowSec = Date.now() / 1000,
  toleranceSec = 300,
): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', secretToken).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`);
  const got = Buffer.from(signature);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
