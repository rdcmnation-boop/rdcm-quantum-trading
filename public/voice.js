// Voz del pulpo: cuenta en español lo que piensa y hace. Usa la voz del propio navegador (sin servicios externos).
// Empieza en silencio y solo suena si el usuario la activa (los navegadores exigen un toque; además evita sorpresas).
import { tr, lang } from '/i18n.js';
const KEY = 'qt_voice';
const ok = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
let on = false; try { on = localStorage.getItem(KEY) === '1'; } catch { on = false; }
if (!ok) on = false;
let queue = []; let busy = false; let gen = 0; let lastEnd = 0; let current = ''; const said = new Map(); const subs = new Set();

const speechEn = (t) => moneyEn(String(t)).replace(/×/g, ' times ').replace(/(\d)\s*%/g, '$1 percent').replace(/\bUSD\b/g, 'dollars').replace(/\+(\d)/g, 'plus $1').replace(/-(\d)/g, 'minus $1').replace(/(\d)\.(\d)/g, '$1 point $2').replace(/\s+/g, ' ').trim();
const moneyEs = (s) => s.replace(/\$(\d[\d,]*)\.(\d{2})\b/g, (_, a, c) => (c === '00' ? `${a} dólares` : `${a} dólares con ${Number(c)}`)).replace(/\$(\d[\d,]*)/g, '$1 dólares');
const moneyEn = (s) => s.replace(/\$(\d[\d,]*)\.(\d{2})\b/g, (_, a, c) => (c === '00' ? `${a} dollars` : `${a} dollars and ${Number(c)} cents`)).replace(/\$(\d[\d,]*)/g, '$1 dollars');
const speechEs = (t) => moneyEs(String(t)).replace(/×/g, ' veces').replace(/(\d)\s*%/g, '$1 por ciento').replace(/\bUSD\b/g, 'dólares').replace(/\+(\d)/g, 'más $1').replace(/-(\d)/g, 'menos $1').replace(/(\d)\.(\d)/g, '$1 punto $2').replace(/\s+/g, ' ').trim();
export const speechText = (t) => (lang() === 'en' ? speechEn(tr(String(t))) : speechEs(String(t)));
const pickVoice = (L = lang()) => { const vs = speechSynthesis.getVoices(); if (L === 'en') { const g = (x) => /premium|enhanced|siri|natural|neural|google/i.test(x.name || ''); return vs.find((x) => /^en[-_]US/i.test(x.lang) && g(x)) || vs.find((x) => /^en[-_]US/i.test(x.lang)) || vs.find((x) => /^en/i.test(x.lang)) || null; } const good = (x) => /premium|enhanced|siri|natural|neural|google/i.test(x.name || ''); const best = (re) => vs.find((x) => re.test(x.lang) && good(x)) || vs.find((x) => re.test(x.lang)); const bs = best(/^es[-_]US/i) || best(/^es[-_]MX/i) || best(/^es/i); if (bs) return bs; return vs.find((v) => /^es[-_]US/i.test(v.lang)) || vs.find((v) => /^es[-_]MX/i.test(v.lang)) || vs.find((v) => /^es/i.test(v.lang)) || null; };
// Voz natural (Azure) si el servidor la tiene configurada; si algo falla, cae a la voz del teléfono.
let azure = false; let audioEl = null; const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
async function refreshAzure() { try { const r = await fetch('/api/voice/config', { credentials: 'same-origin' }); azure = r.ok ? !!(await r.json()).azure : false; } catch { azure = false; } }
async function playAzure(text, L, done) {
  try {
    const r = await fetch('/api/tts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'qt' }, body: JSON.stringify({ text, lang: L }) });
    if (!r.ok) { if (r.status === 503) azure = false; return false; }
    const url = URL.createObjectURL(await r.blob()); const a = audioEl || (audioEl = new Audio()); a.onended = () => { URL.revokeObjectURL(url); done(); }; a.onerror = () => { URL.revokeObjectURL(url); done(); }; a.src = url; await a.play(); return true;
  } catch { return false; }
}
const emit = () => subs.forEach((f) => { try { f({ on, speaking: busy, text: current }); } catch { /* ignora */ } });
function pump() {
  if (busy || !queue.length || !(on || queue[0].force)) return;
  const it = queue.shift(); current = it.text; const L = it.lang || lang();
  const u = new SpeechSynthesisUtterance(it.lang ? speechEn(it.text) : speechText(it.text)); u.lang = L === 'en' ? 'en-US' : 'es-US'; const v = pickVoice(L); if (v) { u.voice = v; u.lang = v.lang; } u.rate = 1.03; u.pitch = 1.05;
  const g = gen; const done = () => { if (g !== gen) return; busy = false; lastEnd = Date.now(); emit(); pump(); };
  u.onend = done; u.onerror = done; busy = true; emit();
  const say = () => { try { speechSynthesis.speak(u); } catch { done(); } };
  if (azure) { playAzure(u.text, L === 'en' ? 'en' : 'es', done).then((okp) => { if (!okp) say(); }); return; }
  say();
}
export const voice = {
  supported: ok,
  get speakingNow() { return busy; },
  get engine() { return azure ? 'azure' : 'browser'; },
  refresh: refreshAzure,
  get on() { return on; },
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  set(v) {
    on = !!v && ok; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* sin almacenamiento */ }
    if (!on) { queue = []; busy = false; current = ''; try { speechSynthesis.cancel(); } catch { /* ignora */ } try { if (audioEl) audioEl.pause(); } catch { /* ignora */ } } else { try { audioEl = audioEl || new Audio(); audioEl.src = SILENT; audioEl.play().catch(() => {}); } catch { /* ignora */ } }
    if (on) this.say(lang() === 'en' ? 'Voice on. I am Superintelligence. I will tell you what I think and do, and why.' : 'Voz activada. Soy Superintelligence. Te cuento lo que pienso y hago, y por qué.', true);
    emit();
  },
  // Informe largo: dice todas las frases en orden (sin recortar la fila ni ignorar repetidas).
  // Radio de noticias: suena aunque la voz del Cerebro esté apagada (el usuario lo pidió); lang 'en' lee el titular tal cual en inglés.
  radio(text, L) { if (!ok || !text) return; queue.push({ text, hi: true, force: true, lang: L === 'en' ? 'en' : undefined }); pump(); },
  // Leer una tarjeta completa en voz alta (botón 🔈): parte el texto en frases cortas y suena aunque la voz del Cerebro esté apagada.
  stop() { gen++; queue = []; busy = false; current = ''; try { speechSynthesis.cancel(); } catch { /* ignora */ } try { if (audioEl) audioEl.pause(); } catch { /* ignora */ } emit(); },
  readAll(list) { if (!ok) return false; this.stop(); for (const text of list) if (text) queue.push({ text, hi: true, force: true }); pump(); return true; },
  stopRadio() { queue = queue.filter((x) => !x.force); if (busy && current && !on) { try { speechSynthesis.cancel(); } catch { /* ignora */ } busy = false; } },
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
