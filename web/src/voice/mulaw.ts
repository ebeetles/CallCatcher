/**
 * G.711 mu-law codec for the browser — a direct port of the server's
 * server/src/audio/mulaw.ts, operating on plain numbers / typed arrays.
 * Twilio Media Streams (and CallCatcher's whole pipeline) speak 8 kHz mono
 * mu-law, so the browser demo client encodes/decodes to the same format.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulawSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinearSample(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

/** Float32 samples (-1..1) → mu-law bytes. */
export function float32ToMulaw(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = linearToMulawSample(Math.round(s * 32767));
  }
  return out;
}

/** mu-law bytes → Float32 samples (-1..1). */
export function mulawToFloat32(mulaw: Uint8Array): Float32Array {
  const out = new Float32Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = mulawToLinearSample(mulaw[i]) / 32768;
  }
  return out;
}

/** Linear-interpolation resampler between arbitrary rates (used for mic 48k→8k). */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

const b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64-encode raw bytes (avoids String.fromCharCode.apply stack limits). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += b64chars[(n >> 18) & 63] + b64chars[(n >> 12) & 63] + b64chars[(n >> 6) & 63] + b64chars[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | ((rem > 1 ? bytes[i + 1] : 0) << 8);
    out += b64chars[(n >> 18) & 63] + b64chars[(n >> 12) & 63];
    out += rem > 1 ? b64chars[(n >> 6) & 63] : "=";
    out += "=";
  }
  return out;
}

/** Decode base64 → raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
