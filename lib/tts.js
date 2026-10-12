// Voz natural con Azure Speech (neural). La llave vive solo en el servidor (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION); el navegador nunca la ve.
// Sin llave configurada, la app sigue usando la voz del propio teléfono.
import crypto from 'node:crypto';

export const VOICES = { es: 'es-US-AlonsoNeural', en: 'en-US-AndrewNeural' };
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// Texto seguro para hablar: sin etiquetas ni controles, máximo 400 caracteres.
export const cleanText = (t) => String(t || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
export const ssml = (text, lang, voice) => {
  const l = lang === 'en' ? 'en-US' : 'es-US';
  return `<speak version="1.0" xml:lang="${l}"><voice name="${xmlEsc(voice)}"><prosody rate="+4%">${xmlEsc(text)}</prosody></voice></speak>`;
};
export const regionOk = (r) => /^[a-z0-9]{3,25}$/.test(String(r || ''));

export function createTts({ env, f = fetch }) {
  const key = env.AZURE_SPEECH_KEY || ''; const region = env.AZURE_SPEECH_REGION || '';
  const enabled = !!(key && regionOk(region));
  const voices = { es: env.AZURE_VOICE_ES || VOICES.es, en: env.AZURE_VOICE_EN || VOICES.en };
  const cache = new Map(); let bytes = 0; // memoria acotada (~16 MB): frases repetidas no se pagan dos veces
  async function speak(text, lang) {
    if (!enabled) return { ok: false, status: 503, error: 'Voz Azure no configurada' };
    const t = cleanText(text); if (!t) return { ok: false, status: 400, error: 'Sin texto' };
    const L = lang === 'en' ? 'en' : 'es'; const ck = crypto.createHash('sha1').update(`${L}|${voices[L]}|${t}`).digest('hex');
    if (cache.has(ck)) { const v = cache.get(ck); cache.delete(ck); cache.set(ck, v); return { ok: true, audio: v }; }
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await f(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST', signal: ctl.signal,
        headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'quantum-trading' }, body: ssml(t, L, voices[L]) });
      if (!r.ok) return { ok: false, status: 502, error: `Azure respondió ${r.status}` };
      const buf = Buffer.from(await r.arrayBuffer()); if (!buf.length || buf.length > 2_000_000) return { ok: false, status: 502, error: 'Audio inválido' };
      cache.set(ck, buf); bytes += buf.length; while (bytes > 16_000_000 && cache.size) { const k = cache.keys().next().value; bytes -= cache.get(k).length; cache.delete(k); }
      return { ok: true, audio: buf };
    } catch (e) { return { ok: false, status: 502, error: 'Azure no respondió' }; } finally { clearTimeout(tm); }
  }
  return { enabled, speak, voices };
}
