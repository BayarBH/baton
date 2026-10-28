import { createDecipheriv, createHash } from 'node:crypto';

/** Decrypted `X-Zoom-App-Context` (https://developers.zoom.us/docs/zoom-apps/zoom-app-context/). */
export interface ZoomAppContext {
  typ: string; // "meeting", "panel", ...
  uid: string;
  mid?: string; // meeting UUID (breakout room UUID inside a breakout)
  pid?: string; // main meeting UUID, inside a breakout room
  ts: number;
  exp: number;
}

/**
 * Layout: [ivLen:1][iv][aadLen:2 LE][aad][cipherLen:4 LE][cipherText][tag:16], AES-256-GCM, key = SHA-256(client secret).
 * Returns undefined for anything malformed, forged or expired.
 */
export function decryptAppContext(header: string, clientSecret: string, nowMs = Date.now()): ZoomAppContext | undefined {
  try {
    const buf = Buffer.from(header, 'base64');
    let o = 0;
    const ivLen = buf.readUInt8(o);
    const iv = buf.subarray((o += 1), (o += ivLen));
    const aadLen = buf.readUInt16LE(o);
    const aad = buf.subarray((o += 2), (o += aadLen));
    const cipherLen = buf.readUInt32LE(o);
    const cipherText = buf.subarray((o += 4), (o += cipherLen));
    const tag = buf.subarray(o, o + 16);
    if (tag.length !== 16) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(clientSecret).digest(), iv);
    if (aad.length) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const ctx = JSON.parse(Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8')) as ZoomAppContext;
    // ponytail: the docs say "long" without a unit; accept seconds or milliseconds.
    const expMs = ctx.exp < 1e12 ? ctx.exp * 1000 : ctx.exp;
    return expMs > nowMs ? ctx : undefined;
  } catch {
    return undefined;
  }
}
