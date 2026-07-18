/**
 * G.711 mu-law codec + small audio helpers.
 * Twilio Media Streams speak 8kHz mono mu-law; everything internal uses that too.
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

/** PCM16LE buffer -> mulaw buffer. */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = linearToMulawSample(pcm.readInt16LE(i * 2));
  }
  return out;
}

/** mulaw buffer -> PCM16LE buffer. */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    out.writeInt16LE(mulawToLinearSample(mulaw[i]), i * 2);
  }
  return out;
}

export const MULAW_SILENCE = 0xff;
export const SAMPLE_RATE = 8000;
export const BYTES_PER_20MS = 160;

/** Generate a mulaw sine tone (used by the mock TTS so demos are audible). */
export function mulawTone(durationMs: number, freqHz = 440, amplitude = 0.25): Buffer {
  const samples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    // Soft attack/decay to avoid clicks.
    const env = Math.min(1, i / 80, (samples - i) / 80);
    const v = Math.round(Math.sin(2 * Math.PI * freqHz * t) * 32767 * amplitude * env);
    out[i] = linearToMulawSample(v);
  }
  return out;
}

export function mulawSilence(durationMs: number): Buffer {
  return Buffer.alloc(Math.round((durationMs / 1000) * SAMPLE_RATE), MULAW_SILENCE);
}
