import type { TtsProvider } from "../types.ts";
import { config } from "../../config.ts";

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/**
 * Azure Speech (Cognitive Services) TTS over the REST v1 endpoint. Requests
 * `raw-8khz-8bit-mono-mulaw` — headerless mulaw at 8k — so bytes go straight to
 * the phone leg with no transcoding, like the Deepgram/ElevenLabs providers.
 *
 * Chosen for bilingual receptionists: the default voice is a Mandarin
 * *multilingual* neural voice that speaks both the English greeting and Mandarin
 * replies naturally from the same voice. ~0.5M free chars/month on the F0 tier.
 */
export class AzureTts implements TtsProvider {
  readonly id = "azure";

  voices() {
    return [
      { id: "zh-CN-XiaoxiaoMultilingualNeural", label: "Xiaoxiao — bilingual, warm (female, EN+中文)" },
      { id: "zh-CN-YunyiMultilingualNeural", label: "Yunyi — bilingual, natural (male, EN+中文)" },
      { id: "zh-CN-XiaoxiaoNeural", label: "Xiaoxiao — friendly (female, 中文)" },
      { id: "zh-CN-YunxiNeural", label: "Yunxi — calm, warm (male, 中文)" },
      { id: "zh-CN-XiaoyiNeural", label: "Xiaoyi — lively (female, 中文)" },
      { id: "zh-CN-YunyangNeural", label: "Yunyang — professional, news (male, 中文)" },
    ];
  }

  async *synthesize(text: string, voiceId: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const region = config.azureSpeechRegion;
    const voice = voiceId || "zh-CN-XiaoxiaoMultilingualNeural";
    // Multilingual voices auto-detect the language of the text, so one voice
    // handles both the English greeting and Mandarin replies.
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">` +
      `<voice name="${voice}">${escapeXml(text)}</voice></speak>`;
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      signal,
      headers: {
        "Ocp-Apim-Subscription-Key": config.azureSpeechKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-8khz-8bit-mono-mulaw",
        "User-Agent": "callcatcher",
      },
      body: ssml,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`Azure TTS ${res.status}: ${body.slice(0, 200)}`);
    }
    const reader = (res.body as any).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) yield Buffer.from(value);
    }
  }
}
