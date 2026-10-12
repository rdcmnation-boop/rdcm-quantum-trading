// Noticias de trading: qué es nuevo, cómo se lee en voz alta y qué merece un aviso. Solo lectura; sin llamadas de red aquí.
export const keyOf = (i) => String((i && i.title) || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
export const freshItems = (items, seen) => (items || []).filter((i) => i && i.title && !seen.has(keyOf(i)));
export const isUrgent = (i) => !!(i && (i.neg || (i.coins && i.coins.length && i.sent === 1)));
const ago = (t) => { if (!t) return ''; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`; };
export const agoNews = ago;
export const introFor = (i, en) => { const s = i.src ? `${i.src.replace(/\.(com|co|org)$/i, '')}: ` : ''; const c = i.coins && i.coins.length ? i.coins.join(en ? ' and ' : ' y ') : ''; return en ? `${s}${i.neg ? 'negative news' : i.pos ? 'positive news' : 'news'}${c ? ` about ${c}` : ''}.` : `${s}${i.neg ? 'noticia negativa' : i.pos ? 'noticia positiva' : 'noticia'}${c ? ` sobre ${c}` : ''}.`; };
// Aviso del navegador: título corto y cuerpo con el titular (sin HTML).
export function notifyFor(list) {
  if (!list.length) return null; const u = list.find((i) => i.neg) || list.find(isUrgent) || list[0];
  return { title: u.neg ? '⚠ Noticia negativa de trading' : list.length > 1 ? `📰 ${list.length} noticias nuevas de trading` : '📰 Noticia de trading', body: String(u.title).slice(0, 140), tag: 'qt-news' };
}
const K = { seen: 'qt_nseen', notif: 'qt_nnotif', radio: 'qt_nradio' };
export const store = {
  seen() { try { return new Set(JSON.parse(localStorage.getItem(K.seen) || '[]')); } catch { return new Set(); } },
  saveSeen(s) { try { localStorage.setItem(K.seen, JSON.stringify([...s].slice(-200))); } catch { /* sin almacenamiento */ } },
  get(k) { try { return localStorage.getItem(K[k]) === '1'; } catch { return false; } },
  set(k, v) { try { localStorage.setItem(K[k], v ? '1' : '0'); } catch { /* sin almacenamiento */ } },
};
