// Voz de solo lectura: responde preguntas sobre lo que YA está en pantalla (qué hace, noticias, por qué compró, riesgo, mercado).
// Seguridad: este módulo no hace llamadas de red, no toca sesiones, claves ni cuentas y no puede ordenar operaciones.
// Escuchar una frase nunca inicia sesión, cambia de cuenta, abre el panel del dueño ni opera: solo elige qué frase leer en voz alta.
const has = (t, re) => re.test(t);
const clean = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ñ]/g, ' ').replace(/\s+/g, ' ').trim();

export function intentOf(text) {
  const t = clean(text); if (!t) return 'none';
  if (has(t, /\b(silencio|callate|calla|basta|para ya|stop|mute|quiet|shut up|terminar|adios|bye)\b/)) return 'mute';
  if (has(t, /\b(futuro|prediccion|predecir|proyeccion|time machine|maquina del tiempo|forecast|future|pronostico)\b/)) return 'future';
  if (has(t, /\b(noticia|noticias|news|headline)\b/)) return 'news';
  if (has(t, /\b(por que|porque|razon|why|reason|motivo|compraste|compro por|bought)\b/)) return 'why';
  if (has(t, /\b(compra|compres|comprar|compralo|compramelo|buy|adquiere)\b/)) return 'buy';
  if (has(t, /\b(riesgo|risk|peligro)\b/)) return 'risk';
  if (has(t, /\b(mercado|market|regimen|tendencia)\b/)) return 'market';
  if (has(t, /\b(tienes|posicion|posiciones|portafolio|cartera|holdings|invertido|positions)\b/)) return 'holdings';
  if (has(t, /\b(listo|listas|listos|oportunidad|oportunidades|candidat\w*|ready|opportunit\w*)\b/)) return 'ready';
  if (has(t, /\b(tope|topes|limite|limites|limit|limits|caps)\b/)) return 'limits';
  if (has(t, /\b(gananc\w*|perdid\w*|resultado|profit|rendimiento|cuanto he ganado)\b/)) return 'profit';
  if (has(t, /\b(error|errores|problema|problemas|falla|fallas)\b/)) return 'errors';
  if (has(t, /\b(resumen|informe|reporte|report|summary)\b/)) return 'report';
  if (has(t, /\b(que haces|que estas haciendo|haciendo|what are you doing|status|estado|como vas)\b/)) return 'status';
  if (has(t, /\b(ayuda|que puedes|que sabes|help)\b/)) return 'help';
  if (has(t, /\b(hola|gracias|thanks|hello|hey)\b/)) return 'hello';
  return 'unknown';
}

const pct = (s) => String(s || '').trim();
const top = (d) => (d.rows || []).filter((r) => r.kind === 'buy' || /listo|compr/i.test(r.state || ''))[0] || null;
const scout = (d, n) => ((d.scouts || []).find((s) => s.name === n) || {}).val || '';

export function statusPhrases(d) {
  const out = []; const th = d.thoughts || []; const buy = th.find((x) => x.k === 'buy'); const sell = th.find((x) => x.k === 'sell'); const risk = th.find((x) => x.k === 'risk');
  const mk = scout(d, 'MERCADO'); const nw = scout(d, 'NOTICIAS'); const mv = scout(d, 'MOVIMIENTOS');
  if (buy) out.push(buy.text); else if (sell) out.push(sell.text);
  if (risk) out.push(risk.text);
  const hold = th.find((x) => x.k === 'hold'); if (!buy && !sell && hold) out.push(hold.text);
  if (mk && !/analizando/.test(mk)) out.push(`El mercado está ${mk}.`);
  if (nw && !/leyendo/.test(nw)) out.push(/freno/.test(nw) ? `Noticias: ${nw}. No abro posiciones nuevas.` : 'Noticias: sin alertas negativas.');
  if (mv && !/escaneando/.test(mv)) out.push(`Mejor movimiento ahora: ${mv}.`);
  return out.filter(Boolean);
}

export function answerFor(intent, d, bn = {}, extra = {}) {
  d = d || {}; bn = bn || {}; const sp = statusPhrases(d); const base = (x) => String(x || '').replace('-USD', ''); const $ = (n) => `$${Number(n || 0).toFixed(2)}`;
  switch (intent) {
    case 'news': { const nw = scout(d, 'NOTICIAS'); return !nw || /leyendo/.test(nw) ? 'Todavía estoy leyendo las noticias.' : /freno/.test(nw) ? `Hay noticias negativas: ${nw}. Por eso frené las compras nuevas.` : 'No hay noticias negativas ahora. Sigo vigilando.'; }
    case 'why': { const b = (d.thoughts || []).find((x) => x.k === 'buy'); if (b) return b.text; const r = (d.rows || []).find((x) => x.why); return r ? `${r.sym}: ${r.why}` : 'No he comprado nada nuevo todavía. Espero una señal clara que supere los costos.'; }
    case 'risk': { const r = (d.thoughts || []).find((x) => x.k === 'risk'); return r ? r.text : `El riesgo está ${scout(d, 'RIESGO') || 'normal'}.`; }
    case 'market': { const m = scout(d, 'MERCADO'); return m && !/analizando/.test(m) ? `El mercado está ${m}.` : 'Todavía estoy analizando el mercado.'; }
    case 'status': case 'report': return sp.length ? sp.slice(0, intent === 'report' ? 5 : 2).join(' ') : 'Estoy vigilando las criptos y esperando una señal clara.';
    case 'holdings': { const h = bn.holdings || []; return h.length ? `Tengo ${h.length} posición${h.length > 1 ? 'es' : ''}: ${h.slice(0, 5).map((x) => `${base(x.symbol)} ${$(x.value)}`).join(', ')}.` : 'Ahora mismo no tengo posiciones abiertas.'; }
    case 'ready': { const r = (d.rows || []).filter((x) => /listo|compr/i.test(x.state || '')); return r.length ? `Listas para comprar: ${r.slice(0, 3).map((x) => `${x.sym}${x.conf ? ` con confianza ${x.conf} por ciento` : ''}`).join(', ')}.` : 'Ninguna cripto cumple todas las reglas ahora. Sigo vigilando.'; }
    case 'limits': { const L = bn.limits; return L ? `Compro ${$(L.usd)} por vez, con tope de ${$(L.maxOrderUsd)} por orden y ${$(L.maxDailyUsd)} por día. Llevo ${$(L.spent24)} hoy. El stop es ${L.stopLossPct} por ciento bajo el costo.` : 'Todavía no tengo tus topes cargados.'; }
    case 'profit': return extra.profit ? `Esto es lo que ves en pantalla: ${extra.profit}` : 'Mira la tarjeta Ganado desde que se encendió el bot para el resultado exacto.';
    case 'errors': { const n = (bn.recent || []).filter((o) => o.status && o.status !== 'ok').length; return n ? `Hay ${n} orden${n > 1 ? 'es' : ''} reciente${n > 1 ? 's' : ''} con error. El motivo está en el Tablero.` : 'No veo errores recientes.'; }
    case 'buy': { const r = (d.rows || []).find((x) => /listo/i.test(x.state || '')); return r ? `${r.sym} está lista${r.conf ? ` con confianza ${r.conf} por ciento` : ''}.` : 'Ninguna cripto cumple todas las reglas todavía.'; }
    case 'future': return extra.future ? extra.future : 'Abre Mercado y usa la Máquina del Tiempo: elige una cripto o una acción y te cuento los futuros posibles. No puedo predecir, solo simular.';
    case 'help': return 'Pregúntame qué hago, las noticias, por qué compré, qué está listo, mis posiciones, mis topes o el riesgo. En papel también puedes decirme: compra cuando esté listo.';
    case 'hello': return 'Hola. Soy Superintelligence. Pregúntame lo que quieras sobre lo que hago.';
    default: return 'Solo puedo contarte lo que hago, las noticias y por qué compro. Con dinero real no puedo operar ni abrir cuentas por voz.';
  }
}

// Escucha una frase (si el navegador lo permite) y la entrega como texto. No guarda audio ni lo envía a ningún servidor propio.
export function listenOnce(lang, onText, onEnd) {
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition); if (!SR) return false;
  const r = new SR(); r.lang = lang === 'en' ? 'en-US' : 'es-US'; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
  r.onresult = (e) => { try { onText(String(e.results[0][0].transcript || '')); } catch { /* ignora */ } };
  r.onend = () => { try { onEnd(); } catch { /* ignora */ } }; r.onerror = r.onend;
  try { r.start(); return true; } catch { return false; }
}

// Frecuencia automática que se ajusta sola: si lo silencias enseguida habla menos; si lo dejas escuchar mucho rato, habla un poco más.
const KEY = 'qt_vint';
export const autoPace = {
  get() { try { const v = Number(localStorage.getItem(KEY)); return v >= 60 && v <= 900 ? v : 150; } catch { return 150; } },
  set(v) { try { localStorage.setItem(KEY, String(Math.max(60, Math.min(900, Math.round(v))))); } catch { /* sin almacenamiento */ } },
  muted() { this.set(this.get() * 1.6); },
  liked() { this.set(this.get() * 0.9); },
};
