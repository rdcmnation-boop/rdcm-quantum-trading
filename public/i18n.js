// Idioma Español / English. El texto del app está escrito en español; en inglés se traduce al mostrarlo
// (diccionario + reglas con huecos {0}), así lo que escribe el motor del bot, los agentes y los errores también sale en inglés.
// Lo que no esté en el diccionario se queda en español: nunca se inventa una traducción.
const KEY = 'qt_lang';
let cur = 'es';
try { const s = localStorage.getItem(KEY); cur = s === 'en' || s === 'es' ? s : (/^en/i.test(navigator.language || '') ? 'en' : 'es'); } catch { cur = 'es'; }
const exact = new Map(); const pats = []; const cache = new Map(); const subs = new Set(); let loaded = false;

export const lang = () => cur;
export const onLang = (f) => { subs.add(f); return () => subs.delete(f); };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function build(list) {
  for (const [es, en] of list) {
    const key = norm(es);
    if (!/\{\d+\}/.test(key)) { exact.set(key, en); continue; }
    const parts = key.split(/\{(\d+)\}/); const order = []; let re = '^';
    parts.forEach((p, i) => { if (i % 2) { order.push(Number(p)); re += '(.+?)'; } else re += esc(p); });
    pats.push({ re: new RegExp(`${re}$`), en, order, len: key.replace(/\{\d+\}/g, '').length });
  }
  pats.sort((a, b) => b.len - a.len);
  loaded = true;
}
export async function loadDict() {
  if (loaded) return;
  try { const m = await import('/i18n-en.js'); build(m.default); } catch { loaded = true; }
}

function tr1(n, depth = 0) {
  if (cache.has(n)) return cache.get(n);
  let out = n;
  if (exact.has(n)) out = exact.get(n);
  else {
    let hit = false;
    for (const p of pats) {
      const m = p.re.exec(n); if (!m) continue;
      out = p.en.replace(/\{(\d+)\}/g, (_, i) => { const g = m[1 + p.order.indexOf(Number(i))]; return g === undefined ? '' : (depth < 4 ? tr1(norm(g), depth + 1) : g); });
      hit = true; break;
    }
    if (!hit && depth < 4) {
      const em = /^([^\p{L}\p{N}{]*)(.*?)\s*([→›»…]*)$/u.exec(n);
      if (em && em[2] && (em[1] || em[3].trim())) { const r = tr1(em[2], depth + 1); if (r !== em[2]) { cache.set(n, em[1] + r + em[3]); return em[1] + r + em[3]; } }
      const sym = /^([A-Z0-9-]{2,12}): (.+)$/.exec(n);
      if (sym) { const r = tr1(sym[2], depth + 1); if (r !== sym[2]) out = `${sym[1]}: ${r}`; }
      if (out === n && n.includes(' · ')) { const segs = n.split(' · '); const t = segs.map((s) => tr1(s, depth + 1)); if (t.some((x, i) => x !== segs[i])) out = t.join(' · '); }
      if (out === n) { const segs = n.split(/(?<=[.;!?])\s+/); if (segs.length > 1) { const t = segs.map((s) => tr1(s, depth + 1)); if (t.some((x, i) => x !== segs[i])) out = t.join(' '); } }
      if (out === n) { const segs = n.split(/;\s+/); if (segs.length > 1) { const t = segs.map((s) => tr1(s, depth + 1)); if (t.some((x, i) => x !== segs[i])) out = t.join('; '); } }
    }
  }
  if (cache.size > 4000) cache.clear();
  cache.set(n, out); return out;
}
// Traduce un texto (conserva espacios al inicio y al final). En español no hace nada.
export function tr(s) {
  if (cur !== 'en' || typeof s !== 'string' || !s || !loaded) return s;
  const lead = /^\s*/.exec(s)[0]; const trail = /\s*$/.exec(s)[0]; const core = s.trim(); if (!core) return s;
  return lead + tr1(norm(core)) + trail;
}

// ---- DOM: traduce nodos de texto y atributos; un observador cubre lo que el app dibuja después ----
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'CANVAS', 'SVG', 'NOSCRIPT']);
const orig = new WeakMap(); let applying = false;
function applyText(n) {
  const p = n.parentNode; if (!p || SKIP.has(p.nodeName) || (p.closest && p.closest('[data-notr]'))) return;
  const o = orig.get(n);
  if (cur === 'en') { if (o && n.data === o.en) return; const es = n.data; const en = tr(es); if (en !== es) { orig.set(n, { es, en }); n.data = en; } else if (o) orig.delete(n); }
  else if (o) { if (n.data === o.en) n.data = o.es; orig.delete(n); }
}
function applyAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue; const store = el.__tr || (el.__tr = {}); const v = el.getAttribute(a);
    if (cur === 'en') { if (store[a] && v === store[a].en) continue; const en = tr(v); if (en !== v) { store[a] = { es: v, en }; el.setAttribute(a, en); } else delete store[a]; }
    else if (store[a]) { if (v === store[a].en) el.setAttribute(a, store[a].es); delete store[a]; }
  }
  if (el.nodeName === 'INPUT' && /^(submit|button)$/.test(el.type) && el.value) { const v = el.value; const en = cur === 'en' ? tr(v) : v; if (en !== v) el.value = en; }
}
function walk(n) {
  if (n.nodeType === 3) return applyText(n);
  if (n.nodeType !== 1 || SKIP.has(n.nodeName)) return;
  applyAttrs(n);
  for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
}
let mo = null;
function observe() {
  if (mo || typeof MutationObserver === 'undefined') return;
  mo = new MutationObserver((muts) => {
    if (applying) return; applying = true;
    try { for (const m of muts) { if (m.type === 'childList') m.addedNodes.forEach(walk); else if (m.type === 'characterData') applyText(m.target); else if (m.type === 'attributes') applyAttrs(m.target); } } finally { applying = false; mo.takeRecords(); }
  });
  mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
function sweep() { applying = true; try { walk(document.body); if (cur === 'en') { const t = tr(document.title); if (t !== document.title) { document.documentElement.__esTitle = document.documentElement.__esTitle || document.title; document.title = t; } } else if (document.documentElement.__esTitle) { document.title = document.documentElement.__esTitle; } } finally { applying = false; } }

export async function setLang(l) {
  cur = l === 'en' ? 'en' : 'es';
  try { localStorage.setItem(KEY, cur); } catch { /* sin almacenamiento */ }
  document.documentElement.lang = cur;
  if (cur === 'en') await loadDict();
  cache.clear(); sweep(); renderSwitches(); subs.forEach((f) => { try { f(cur); } catch { /* ignora */ } });
}
export async function initI18n() {
  document.documentElement.lang = cur;
  if (cur === 'en') await loadDict();
  observe(); if (cur === 'en') sweep(); renderSwitches();
}

// ---- Selector ES | EN ----
function renderSwitches() {
  document.querySelectorAll('.langsw').forEach((el) => {
    el.innerHTML = `<button type="button" data-l="es" class="${cur === 'es' ? 'on' : ''}" aria-pressed="${cur === 'es'}" lang="es" data-notr>ES</button><button type="button" data-l="en" class="${cur === 'en' ? 'on' : ''}" aria-pressed="${cur === 'en'}" lang="en" data-notr>EN</button>`;
  });
}
document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('.langsw button[data-l]'); if (b && b.dataset.l !== cur) setLang(b.dataset.l); });
// Crea un selector en el contenedor dado o, si no hay, uno flotante arriba a la derecha.
export function mountSwitch(container) {
  if (document.querySelector('.langsw')) { renderSwitches(); return; }
  const s = document.createElement('div'); s.className = `langsw${container ? '' : ' float'}`; s.setAttribute('data-notr', ''); (container || document.body).prepend(s); renderSwitches();
}
