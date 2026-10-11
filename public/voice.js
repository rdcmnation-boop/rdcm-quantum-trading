// Voz del pulpo: cuenta en español lo que piensa y hace. Usa la voz del propio navegador (sin servicios externos).
// Empieza en silencio y solo suena si el usuario la activa (los navegadores exigen un toque; además evita sorpresas).
import { tr, lang } from '/i18n.js';
const KEY = 'qt_voice';
const ok = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
let on = false; try { on = localStorage.getItem(KEY) === '1'; } catch { on = false; }
if (!ok) on = false;
let queue = []; let busy = false; let lastEnd = 0; let current = ''; const said = new Map(); const subs = new Set();

const speechEn = (t) => String(t).replace(/×/g, ' times ').replace(/(\d)\s*%/g, '$1 percent').replace(/\bUSD\b/g, 'dollars').replace(/\+(\d)/g, 'plus $1').replace(/-(\d)/g, 'minus $1').replace(/(\d)\.(\d)/g, '$1 point $2').replace(/\s+/g, ' ').trim();
const speechEs = (t) => String(t).replace(/×/g, ' veces').replace(/(\d)\s*%/g, '$1 por ciento').replace(/\bUSD\b/g, 'dólares').replace(/\+(\d)/g, 'más $1').replace(/-(\d)/g, 'menos $1').replace(/(\d)\.(\d)/g, '$1 punto $2').replace(/\s+/g, ' ').trim();
export const speechText = (t) => (lang() === 'en' ? speechEn(tr(String(t))) : speechEs(String(t)));
const pickVoice = () => { const vs = speechSynthesis.getVoices(); if (lang() === 'en') return vs.find((x) => /^en[-_]US/i.test(x.lang)) || vs.find((x) => /^en/i.test(x.lang)) || null; return vs.find((v) => /^es[-_]US/i.test(v.lang)) || vs.find((v) => /^es[-_]MX/i.test(v.lang)) || vs.find((v) => /^es/i.test(v.lang)) || null; };
const emit = () => subs.forEach((f) => { try { f({ on, speaking: busy, text: current }); } catch { /* ignora */ } });
function pump() {
  if (!on || busy || !queue.length) return;
  const it = queue.shift(); current = it.text;
  const u = new SpeechSynthesisUtterance(speechText(it.text)); u.lang = lang() === 'en' ? 'en-US' : 'es-US'; const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } u.rate = 1.03; u.pitch = 1.05;
  const done = () => { busy = false; lastEnd = Date.now(); emit(); pump(); };
  u.onend = done; u.onerror = done; busy = true; emit();
  try { speechSynthesis.speak(u); } catch { done(); }
}
export const voice = {
  supported: ok,
  get on() { return on; },
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  set(v) {
    on = !!v && ok; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* sin almacenamiento */ }
    if (!on) { queue = []; busy = false; current = ''; try { speechSynthesis.cancel(); } catch { /* ignora */ } } else this.say(lang() === 'en' ? 'Voice on. I am Superintelligence. I will tell you what I think and do, and why.' : 'Voz activada. Soy Superintelligence. Te cuento lo que pienso y hago, y por qué.', true);
    emit();
  },
  // Informe largo: dice todas las frases en orden (sin recortar la fila ni ignorar repetidas).
  sayAll(list) {
    if (!on) return; queue = []; for (const text of list) if (text) queue.push({ text, hi: true });
    pump();
  },
  // hi = decisión importante (compra, venta, freno): hace fila. Lo demás solo suena si el pulpo está libre.
  say(text, hi = false) {
    if (!on || !text) return;
    const now = Date.now(); const k = String(text).slice(0, 80) + lang();
    if (now - (said.get(k) || 0) < 90000) return; said.set(k, now);
    if (said.size > 80) for (const [a, t] of said) if (now - t > 90000) said.delete(a);
    if (hi) { queue.push({ text, hi }); if (queue.length > 4) queue = queue.filter((x) => x.hi).slice(-4); }
    else if (!busy && !queue.length && now - lastEnd > 2500) queue.push({ text, hi });
    pump();
  },
};
