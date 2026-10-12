// Interfaz de Quantum Trading. Sin librerías; todo dato dinámico pasa por esc() antes de insertarse.
import { genEd25519 } from '/keygen.js';
import { voice } from '/voice.js';
import { keyOf, freshItems, isUrgent, introFor, notifyFor, agoNews, store as nstore } from '/newsradio.js';
import { intentOf, answerFor, statusPhrases, listenOnce, autoPace } from '/voicecmd.js';
import { initI18n, mountSwitch, tr, onLang, lang } from '/i18n.js';
await initI18n(); mountSwitch(null);
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }));
const num = (n, d = 6) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

const state = { user: null, me: null, tab: 'resumen', authMode: 'login', needTotp: false, useRecovery: false, resetToken: null, flash: '' };

async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'qt' },
    body: body ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch { /* sin cuerpo */ }
  if (r.status === 401 && state.user && !path.startsWith('/api/auth')) { state.user = null; render(); }
  if (!r.ok) { const e = new Error(j.error || 'Error'); e.data = j; e.status = r.status; throw e; }
  return j;
}

function setMsg(node, text, ok = false) {
  node.textContent = text || '';
  node.className = `msg ${text ? (ok ? 'ok' : 'err') : ''}`;
}

// ============================ Autenticación ============================
// Recuperar contraseña (pedir el enlace / elegir una nueva con el token del enlace)
function viewRecover() {
  const reset = state.authMode === 'reset';
  $('#root').innerHTML = `
  <div class="auth">
    <div class="brand"><small>RDCMNATION</small>Quantum Trading</div>
    <div class="card"><h2>${reset ? 'Elige una contraseña nueva' : 'Recuperar contraseña'}</h2>
      <form id="rf" class="form" style="margin-top:10px">
        ${reset ? '<label class="full">Contraseña nueva (mínimo 10 caracteres)<input name="password" type="password" required minlength="10" autocomplete="new-password"></label>'
          : '<label class="full">Correo de tu cuenta<input name="email" type="email" required autocomplete="username"></label>'}
        <button class="btn full" type="submit">${reset ? 'Guardar contraseña' : 'Enviar enlace'}</button>
        <div class="msg full" id="m"></div>
        <button class="btn ghost full" type="button" id="back">Volver a entrar</button>
      </form>
      ${reset ? '' : '<p class="muted" style="font-size:12px">Te enviaremos un enlace válido 30 minutos. Si no llega, revisa spam; si el servicio de correo aún no está activo, escríbenos y te ayudamos a mano.</p>'}
    </div>
  </div>`;
  $('#back').onclick = () => { state.authMode = 'login'; state.resetToken = null; viewAuth(); };
  $('#rf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)); const m = $('#m');
    try {
      if (reset) { await api('POST', '/api/auth/reset', { token: state.resetToken, password: f.password }); state.authMode = 'login'; state.resetToken = null; state.flash = 'Contraseña cambiada. Ya puedes entrar.'; viewAuth(); }
      else { const r = await api('POST', '/api/auth/forgot', { email: f.email }); setMsg(m, r.message, true); }
    } catch (err) { setMsg(m, err.message); }
  });
}

function viewAuth() {
  if (state.authMode === 'forgot' || state.authMode === 'reset') return viewRecover();
  const reg = state.authMode === 'register';
  $('#root').innerHTML = `
  <div class="auth">
    <div class="brand"><small>RDCMNATION</small>Quantum Trading</div>
    <div class="card">
      <div class="tabs"><button data-m="login" class="${reg ? '' : 'on'}">Entrar</button><button data-m="register" class="${reg ? 'on' : ''}">Crear cuenta</button></div>
      <form id="f" class="form" style="margin-top:14px" autocomplete="on">
        <label class="full">Correo<input name="email" type="email" required autocomplete="username"></label>
        <label class="full">Contraseña${reg ? ' (mínimo 10 caracteres)' : ''}<input name="password" type="password" required minlength="${reg ? 10 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        ${state.needTotp ? (state.useRecovery ? '<label class="full">Código de respaldo (xxxxx-xxxxx)<input name="recovery" autocomplete="off" required></label>' : '<label class="full">Código 2FA (6 dígitos)<input name="totp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>') + `<button class="btn ghost full" type="button" id="rec">${state.useRecovery ? 'Usar la app de 2FA' : 'Perdí mi teléfono: usar código de respaldo'}</button>` : ''}
        ${reg ? `<label class="check full"><input type="checkbox" name="tos" required><span>Soy mayor de 18 años y acepto los <a href="/legal.html#terminos" target="_blank" rel="noopener">Términos</a>, la <a href="/legal.html#privacidad" target="_blank" rel="noopener">Privacidad</a> y el <a href="/legal.html#riesgo" target="_blank" rel="noopener">Aviso de riesgo</a>. Entiendo que esto no es asesoría financiera y que puedo perder dinero.</span></label>` : ''}
        <button class="btn full" type="submit">${reg ? 'Crear cuenta' : 'Entrar'}</button>
        <div class="msg full" id="m"></div>
        ${reg ? '' : '<button class="btn ghost full" type="button" id="fg">¿Olvidaste tu contraseña?</button>'}
      </form>
    </div>
    <p class="muted" style="font-size:12px">Cada cuenta es privada: ningún cliente puede ver los datos de otro.</p>
  </div>`;
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.authMode = b.dataset.m; state.needTotp = false; viewAuth(); }));
  if (state.flash) { setMsg($('#m'), state.flash, true); state.flash = ''; }
  const fg = $('#fg'); if (fg) fg.onclick = () => { state.authMode = 'forgot'; viewAuth(); };
  const rec = $('#rec'); if (rec) rec.onclick = () => { state.useRecovery = !state.useRecovery; viewAuth(); };
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const m = $('#m');
    try {
      const r = await api('POST', reg ? '/api/auth/register' : '/api/auth/login',
        reg ? { email: f.email, password: f.password, acceptTos: f.tos === 'on' } : { email: f.email, password: f.password, totp: f.totp, recovery: f.recovery });
      state.user = r.user; state.needTotp = false; state.useRecovery = false; state.tab = r.user.role === 'owner' ? 'o_hoy' : 'resumen';
      await boot();
    } catch (err) {
      if (err.data && err.data.need_totp) { const keep = { e: f.email, p: f.password }; state.needTotp = true; viewAuth(); $('#f').email.value = keep.e; $('#f').password.value = keep.p; $('#m').textContent = err.message; $('#m').className = 'msg err'; return; }
      setMsg(m, err.message);
    }
  });
}

// ============================ Estructura ============================
const CLIENT_TABS = [['resumen', 'Resumen'], ['mercado', 'Mercado'], ['exchanges', 'Conectar'], ['bot', 'Bot'], ['ordenes', 'Órdenes'], ['descargar', 'Bot descargable'], ['cuenta', 'Cuenta']];
const OWNER_TABS = [['o_hoy', 'Hoy'], ['bot', 'Mi bot'], ['o_cerebro', 'Cerebro'], ['o_clientes', 'Clientes'], ['o_finanzas', 'Finanzas'], ['o_launch', 'Lanzar'], ['exchanges', 'Conectar'], ['mercado', 'Mercado'], ['ordenes', 'Mis órdenes'], ['o_seguridad', 'Seguridad'], ['o_ajustes', 'Ajustes'], ['cuenta', 'Mi cuenta']];
const ICONS = {
  resumen: '<path d="M4 13h6V4H4zM14 20h6V4h-6zM4 20h6v-4H4z"/>', mercado: '<path d="M3 17l5-5 4 4 8-9M15 7h5v5"/>', exchanges: '<path d="M9 7H6a3 3 0 000 6h3M15 7h3a3 3 0 010 6h-3M8 10h8"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01"/>', mas: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  o_hoy: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', o_cerebro: '<path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 0V7a3 3 0 00-3-3zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-3 2"/>',
  o_launch: '<path d="M5 19c1-4 3-7 7-10l3-4 4-1-1 4-4 3c-3 4-6 6-9 8zM9 15l-3 3"/>', o_clientes: '<circle cx="9" cy="9" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 7a3 3 0 010 6M18 15c2 1 3 2 3 4"/>',
};
const ico = (k) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.mas}</svg>`;

function shell() {
  const owner = state.user.role === 'owner';
  const inClient = !owner;
  const main5 = inClient ? [['resumen', 'Resumen'], ['mercado', 'Mercado'], ['bot', 'Bot'], ['exchanges', 'Conectar']] : [['o_hoy', 'Hoy'], ['bot', 'Mi bot'], ['o_cerebro', 'Cerebro'], ['o_clientes', 'Clientes']];
  const mainKeys = main5.map((x) => x[0]);
  const rest = (inClient ? CLIENT_TABS : OWNER_TABS).filter(([k]) => !mainKeys.includes(k));
  const inMore = !mainKeys.includes(state.tab);
  const btn = ([k, l]) => `<button data-t="${k}" class="${state.tab === k ? 'on' : ''}">${ico(k)}<span>${esc(l)}</span></button>`;
  const cur = [...CLIENT_TABS, ...OWNER_TABS].find(([k]) => k === state.tab);
  $('#root').innerHTML = `
  <div class="wrap">
    <div class="top">
      <div class="brand"><small>${owner ? 'Consola del dueño' : 'RDCMNATION'}</small>Quantum Trading</div>
      <div class="who"><span class="chip">${esc(cur ? cur[1] : '')}</span></div>
    </div>
    <div id="main"></div>
    <p class="muted" style="font-size:11px">No es asesoría de inversión ni custodia de fondos. Operar cripto implica riesgo de perder todo el dinero. <a href="/legal.html" target="_blank" rel="noopener">Legal</a></p>
  </div>
  <div class="bar" role="navigation">${main5.map(btn).join('')}<button id="more" class="${inMore ? 'on' : ''}">${ico('mas')}<span>Más</span></button></div>
  <div class="sheet" id="sheet" hidden><div class="sheetb">
    <div class="muted" style="font-size:12px;margin-bottom:6px">${esc(state.user.email)}</div>
    ${rest.map(([k, l]) => `<button class="item" data-t="${k}">${esc(l)}</button>`).join('')}
    <button class="item" id="out" style="color:var(--bad)">Salir</button>
  </div></div>`;
  const go = (k) => { state.tab = k; shell(); loadTab(); };
  document.querySelectorAll('.bar button[data-t], .sheet button[data-t]').forEach((b) => b.addEventListener('click', () => go(b.dataset.t)));
  $('#more').addEventListener('click', () => { $('#sheet').hidden = !$('#sheet').hidden; });
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });
  $('#out').addEventListener('click', async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ya salió */ } state.user = null; state.me = null; render(); });
}

let tabTimer = null;
async function loadTab() {
  if (tabTimer) { clearInterval(tabTimer); tabTimer = null; }
  if (state.user.role === 'owner' && !state.user.totp && state.tab.startsWith('o_') && state.tab !== 'o_ajustes') { state.tab = 'o_ajustes'; shell(); }
  const main = $('#main');
  main.innerHTML = '<div class="card muted">Cargando…</div>';
  try {
    const fn = { resumen: tabResumen, exchanges: tabExchanges, bot: tabBot, ordenes: tabOrdenes, descargar: tabDescargar, cuenta: tabCuenta, mercado: tabMercado, o_hoy: tabHoy,
      o_launch: tabLaunch, o_cerebro: tabCerebro, o_export: tabExport, o_overview: tabOverview, o_clientes: tabClientes, o_finanzas: tabFinanzas, o_seguridad: tabSeguridad, o_ajustes: tabAjustes }[state.tab];
    await fn(main);
    accordionize(main);
  } catch (e) { main.innerHTML = `<div class="card"><span class="neg">${esc(e.message)}</span></div>`; }
}

// ============================ Cliente ============================
const AUTO_PRESET = { autoMode: 'pro', symbol: 'AUTO', strategy: 'sma', usd: 25, intervalMin: 60, fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60, stopLossPct: 8, takeProfitPct: 2, mode: 'paper', paperExchange: 'best', maxPositions: 3, maxOrderUsd: 25, maxDailyUsd: 100, enabled: true };
const DEMO_PRESET = { symbol: 'BTC-USD', strategy: 'dca', usd: 10, intervalMin: 15, mode: 'paper', paperExchange: 'best', maxOrderUsd: 25, maxDailyUsd: 100, enabled: true };
async function quickStart(preset) { await api('PUT', '/api/bot', preset); state.tab = state.user.role === 'owner' ? 'o_hoy' : 'resumen'; shell(); loadTab(); }
const cheapTxt = { coinbase: 'Coinbase', robinhood: 'Robinhood', igual: 'igual' };

function botNowHtml(b) {
  const actTxt = { buy: 'Comprar', sell: 'Vender', hold: 'Mantener' };
  const l = b.last; const auto = b.symbol === 'AUTO';
  const fresh = b.last_run && Date.now() - b.last_run < 180000;
  const status = !b.enabled ? '<span class="chip">Apagado</span>' : fresh ? '<span class="chip paper">● Activo</span>' : '<span class="chip">Esperando ciclo</span>';
  const p = b.position;
  const cta = b.enabled ? `<div class="row" style="margin:6px 0"><button class="btn danger small" id="bn_off">Apagar</button></div>` : `<div class="row" style="margin:8px 0"><button class="btn" id="bn_auto">▶ Encender Cerebro (papel)</button><button class="btn ghost" id="bn_demo">Demo: compra cada 15 min</button></div>`;
  const hold = (b.holdings || []).map((h) => `<tr><td><b>${esc(h.symbol.replace('-USD', ''))}</b> <span class="chip">${esc(h.venue || '')}</span></td><td class="r">${num(h.qty, 6)}</td><td class="r">${h.value !== null ? money(h.value) : '—'}</td><td class="r ${cls(h.unrealized)}">${h.unrealized !== null ? money(h.unrealized) : '—'}</td></tr>`).join('');
  const sc = b.scanner;
  return `<div class="row" style="justify-content:space-between"><div class="row"><b>${auto ? 'Cerebro AUTO' : esc(b.symbol)}</b> ${status}<span class="chip ${b.mode === 'live' ? 'live' : 'paper'}">${b.mode === 'live' ? 'REAL' : 'PAPEL'}</span>${auto ? '' : `<span class="chip">${esc(String(b.strategy).toUpperCase())}</span>`}</div>
      <span class="muted" style="font-size:12px">revisó ${esc(ago(b.last_run))}</span></div>
    ${cta}
    <div class="botnow">${l ? `<span class="act ${esc(l.action)}">${esc(actTxt[l.action] || l.action)}</span> <span class="muted">${esc(l.reason)}</span>` : '<span class="muted">Aún sin decisiones. Enciende el bot aquí arriba.</span>'}</div>
    ${auto && sc ? `<div class="muted" style="font-size:12px;margin-top:6px">Validadas ahora: ${sc.qualified.length ? sc.qualified.map((q) => `<span class="chip">${esc(q.symbol.replace('-USD', ''))} · ${esc(cheapTxt[q.cheaper] || '')}</span>`).join(' ') : 'ninguna (el Cerebro espera)'} · escaneadas ${sc.scanned}</div>` : ''}
    <div class="kpis" style="margin-top:8px">
      <div class="kpi"><div class="l">Resultado total</div><div class="v ${cls(b.total)}">${money(b.total)}</div><div class="s">${money(b.realized)} cerrado</div></div>
      <div class="kpi"><div class="l">${auto ? 'Invertido ahora' : 'Posición'}</div><div class="v" style="font-size:16px">${auto ? (p.value !== null ? money(p.value) : '—') : num(p.qty, 6)}</div><div class="s">${auto ? `${(b.holdings || []).length} cripto(s)` : `${p.value !== null ? money(p.value) : '—'}`} · ${p.unrealized !== null ? `<span class="${cls(p.unrealized)}">${money(p.unrealized)}</span>` : ''}</div></div>
      <div class="kpi"><div class="l">Curva</div>${spark(b.curve.length > 1 ? b.curve : null, 120, 34)}</div>
    </div>
    ${hold ? `<div class="scroll" style="margin-top:6px"><table><thead><tr><th>Posición</th><th class="r">Cant.</th><th class="r">Valor</th><th class="r">No realiz.</th></tr></thead><tbody>${hold}</tbody></table></div>` : ''}
    ${b.errors ? `<div class="msg err">${b.errors} error(es) seguidos del exchange</div>` : ''}
    ${b.recent.length ? `<div class="scroll" style="margin-top:6px"><table><tbody>${b.recent.slice(0, 6).map((o) => `<tr><td>${esc(ago(o.t))}</td><td>${o.side === 'buy' ? 'Compra' : 'Venta'} ${esc(o.symbol)} <span class="chip ${o.mode === 'live' ? 'live' : 'paper'}">${o.mode === 'live' ? 'REAL' : 'papel'}</span></td><td class="r">${money(o.usd)}</td><td>${(() => { const L = { simulated: ['simulada', 'pos'], submitting: ['enviando', 'muted'], submitted: ['enviada, sin confirmar', 'muted'], confirmed: ['confirmada', 'pos'], partial: ['parcial', 'pos'], filled: ['ejecutada', 'pos'], cancelled: ['cancelada', 'neg'], rejected: ['rechazada', 'neg'], unknown: ['resultado desconocido', 'neg'] }[o.lifecycle]; return L ? `<span class="${L[1]}">${L[0]}</span>` : (o.status === 'ok' ? '<span class="pos">ok</span>' : `<span class="neg">${esc(o.status)}</span>`); })()}</td></tr>${o.status !== 'ok' && o.note ? `<tr><td colspan="4" class="neg" style="white-space:normal;font-size:12px;padding-top:0">↳ ${esc(o.note)}</td></tr>` : ''}`).join('')}</tbody></table></div>` : ''}
    ${b.enabled ? '<p class="muted" style="font-size:11px;margin:6px 0 0">El bot trabaja mientras el servidor está despierto. En el plan gratis de Render se duerme sin visitas; con un plan de pago de Render queda siempre despierto.</p>' : ''}`;
}
const friendlyNote = (n) => { const s = String(n || ''); if (/too much precision|nearest\s+[0-9.]+/i.test(s)) return 'Robinhood pidió redondear la cantidad de la orden. El bot ya lo corrige solo y reintenta.'; if (/insufficient|buying power|not enough/i.test(s)) return 'Saldo insuficiente en el exchange para esta orden.'; if (/429|too many requests|rate/i.test(s)) return 'El exchange pidió ir más despacio; el bot reintenta solo.'; return s.length > 140 ? `${s.slice(0, 137)}…` : s; };
const until = (t) => { if (!t) return '—'; const m = Math.round((t - Date.now()) / 60000); return m <= 0 ? 'en breve' : m < 60 ? `en ${m} min` : `en ${Math.round(m / 60)} h`; };
function dashHtml(d) {
  const r = d.real; const p = d.paper; const br = d.brain;
  const none = !r.orders && !r.errors;
  const rows = r.last.map((o) => `<tr><td>${esc(ago(o.t))}</td><td>${o.side === 'buy' ? 'Compra' : 'Venta'} <b>${esc(o.symbol.replace('-USD', ''))}</b> <span class="chip">${esc(o.exchange)}</span></td><td class="r">${money(o.usd)}</td><td>${o.status === 'ok' ? '<span class="pos">ok</span>' : o.old ? '<span class="muted">error antiguo</span>' : '<span class="neg">error</span>'}</td></tr>${o.note ? `<tr><td colspan="4" class="${o.old ? 'muted' : 'neg'}" style="white-space:normal;font-size:12px;padding-top:0">↳ ${esc(o.old ? (/precision/i.test(o.note) ? 'Hace horas. Ahora el bot reintenta solo con el incremento que indica Robinhood (aún sin confirmar en vivo). ' : 'Hace horas. ') : '')}${esc(friendlyNote(o.note))}</td></tr>` : ''}`).join('');
  const showStart = !(d.bot.enabled && d.bot.mode === 'live');
  const start = !showStart ? '' : d.can_live && d.connections.length ? `<form id="ds_f" class="startbox">
      <b>▶ Encender trading automático REAL</b>
      <div class="muted" style="font-size:12px;margin:2px 0 8px">El Cerebro elige las criptos con ventaja y compra solo, en ${d.connections.some((c) => c.exchange === 'robinhood') ? 'tu Robinhood' : 'tu exchange'}. Tú solo pones cuánto por compra.</div>
      <div class="row"><label style="flex:1;min-width:140px">USD por compra<input name="usd" type="number" min="1" step="any" value="5"></label>
      <label style="flex:1;min-width:140px">Exchange<select name="conn">${d.connections.map((c) => `<option value="${esc(c.id)}" ${c.exchange === 'robinhood' ? 'selected' : ''}>${esc(c.exchange)}</option>`).join('')}</select></label></div>
      <label class="check" style="margin:8px 0"><input type="checkbox" name="ack"><span>Entiendo que es dinero REAL y que puedo perder todo lo que invierta.</span></label>
      <button class="btn" type="submit">Encender automático</button><div class="msg" id="ds_m"></div></form>`
    : `<div class="startbox"><b>Para operar de verdad</b><ol class="muted" style="font-size:13px;margin:6px 0 0 18px;padding:0">${d.connections.length ? '' : '<li>Toca <b>Conectar</b> y une tu Robinhood o Coinbase.</li>'}${d.can_live ? '' : '<li>Dueño: <b>Más → Ajustes → Trading REAL → «Solo yo»</b>.</li>'}<li>Vuelve aquí y toca «Encender automático».</li></ol></div>`;
  return `${start}<div class="real ${r.total > 0 ? 'up' : r.total < 0 ? 'down' : ''}">
      <div class="row" style="justify-content:space-between"><span class="chip live">DINERO REAL</span><span class="muted" style="font-size:12px">${d.bot.enabled && d.bot.mode === 'live' ? '● bot real activo' : 'bot real apagado'}</span></div>
      <div class="bigv ${cls(r.total)}">${none ? '$0.00' : money(r.total)}</div>
      <div class="muted" style="font-size:12px">resultado total real${r.estimated ? ' (estimado)' : ''} · ${money(r.realized)} cerrado · ${r.unrealized === null ? '—' : money(r.unrealized)} abierto</div>
      <div class="kpis" style="margin-top:8px"><div class="kpi"><div class="l">Invertido ahora</div><div class="v" style="font-size:16px">${money(r.invested_now)}</div></div>
        <div class="kpi"><div class="l">Compras / ventas</div><div class="v" style="font-size:16px">${r.orders}</div><div class="s">${money(r.bought, 0)} / ${money(r.sold, 0)}</div></div>
        <div class="kpi"><div class="l">Errores (6 h)</div><div class="v ${r.errors ? 'neg' : ''}" style="font-size:16px">${r.errors}</div>${r.errors_old ? `<div class="s">${r.errors_old} anteriores</div>` : ''}</div></div>
      ${none ? '' : `<div class="muted" style="font-size:12px;margin-top:6px">${r.confirmed} confirmada(s) por el broker${r.legacy ? ` · ${r.legacy} anterior(es) sin verificar` : ''}${r.pending ? ` · <b>${r.pending} pendiente(s) de confirmar</b>` : ''}${r.fees_usd ? ` · comisiones reales ${money(r.fees_usd)}` : ''}. ${r.estimated ? 'Hasta que el broker confirme todo, las cifras son estimadas.' : 'Cifras confirmadas por el broker.'}</div>`}
      ${none ? '<p class="muted" style="margin:8px 0 0">Aún no hay operaciones reales. Ve a Bot → «Real: comprar ya» (con trading real activado en Ajustes).</p>' : ''}
      ${r.holdings.length ? `<div class="row" style="margin-top:8px">${r.holdings.map((h) => `<span class="chip"><b>${esc(h.symbol.replace('-USD', ''))}</b> ${h.value !== null ? money(h.value) : '—'} · ${esc(h.venue || '')}</span>`).join(' ')}</div>` : ''}
      ${rows ? `<div class="scroll" style="margin-top:6px"><table><tbody>${rows}</tbody></table></div>` : ''}
    </div>
    <div class="muted" style="font-size:12px;margin-top:8px">Papel (sin dinero): <b class="${cls(p.total)}">${money(p.total)}</b> · ${p.orders} operaciones simuladas</div>
    ${d.perf && d.perf.closed ? `<div class="muted" style="font-size:12px;margin-top:6px">Rendimiento del bot (${d.perf.mode === 'live' ? 'real' : 'papel'}): ${d.perf.closed} operaciones cerradas · ${d.perf.win_rate === null ? '—' : d.perf.win_rate.toFixed(0)} % ganadoras · <span class="${cls(d.perf.pnl)}">${money(d.perf.pnl)}</span> · modo de riesgo: <b>${d.perf.risk === 'normal' ? 'normal' : d.perf.risk === 'defensivo' ? 'defensivo (tamaño reducido)' : 'en pausa'}</b></div>` : ''}
    ${d.news ? `<div class="muted" style="font-size:12px">Noticias: ${d.news.risk_off ? '<span class="neg">riesgo alto, no abre posiciones nuevas</span>' : `sin alerta (${d.news.negatives} negativas) `}· ${esc(ago(d.news.t))}</div>` : ''}
    <div class="brainline"><b>Cerebro</b> ${br.auto ? '<span class="chip paper">aprende y se actualiza solo</span>' : ''}
      <div class="muted" style="font-size:12px">Escáner ${esc(ago(br.scanner_t))}: ${br.qualified} validadas de ${br.scanned}${br.top.length ? ` (${esc(br.top.map((s) => s.replace('-USD', '')).join(', '))})` : ''} · mercado ${esc(br.regime ? br.regime.label : '—')} · próxima revisión ${esc(until(br.next_run))} · v${br.version}</div>
      ${br.lessons.length ? `<div class="muted" style="font-size:12px">Último aprendizaje: ${esc(br.lessons[0].text)}</div>` : ''}</div>`;
}

function liveHtml(d) {
  if (!d || !d.exchanges.length) return '<p class="muted">Conecta Robinhood o Coinbase en <b>Conectar</b> y aquí verás tu saldo, tus órdenes reales y los precios en vivo.</p>';
  return d.exchanges.map((e) => {
    const bal = e.balances.length ? e.balances.map((b) => `<span class="chip"><b>${esc(b.asset)}</b> ${num(b.available, 6)}${b.usd !== null ? ` ≈ ${money(b.usd)}` : ''}</span>`).join(' ') : '<span class="muted">sin saldo visible</span>';
    const q = e.quotes.length ? `<div class="scroll"><table><thead><tr><th>Par</th><th class="r">Compra</th><th class="r">Venta</th><th class="r">Spread</th><th class="r">vs Coinbase</th></tr></thead><tbody>${e.quotes.map((x) => `<tr><td><b>${esc(x.symbol.replace('-USD', ''))}</b></td><td class="r">${money(x.ask, x.ask < 10 ? 4 : 2)}</td><td class="r">${money(x.bid, x.bid < 10 ? 4 : 2)}</td><td class="r">${x.spread_pct.toFixed(2)} %</td><td class="r ${x.gap_pct > 0.1 ? 'neg' : x.gap_pct < -0.1 ? 'pos' : ''}">${x.gap_pct === null ? '—' : pc(x.gap_pct, 2)}</td></tr>`).join('')}</tbody></table></div>` : '';
    const o = e.orders.length ? `<div class="scroll"><table><tbody>${e.orders.slice(0, 6).map((x) => `<tr><td>${esc(ago(x.t))}</td><td>${x.side === 'buy' ? 'Compra' : 'Venta'} <b>${esc(String(x.symbol).replace('-USD', ''))}</b></td><td class="r">${x.qty ? num(x.qty, 6) : '—'}</td><td class="r">${x.price ? money(x.price, x.price < 10 ? 4 : 2) : '—'}</td><td>${esc(x.state)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:12px;margin:4px 0">Sin órdenes recientes en el exchange.</p>';
    return `<div class="c2" style="margin-bottom:8px"><div class="row" style="justify-content:space-between"><b>${esc(e.exchange === 'robinhood' ? 'Robinhood' : 'Coinbase')}</b><span class="muted" style="font-size:12px">${esc(e.label || '')}</span></div>
      <div class="row" style="margin:6px 0">${bal}</div>${q}${o}${e.errors.length ? `<div class="msg err" style="font-size:12px">${e.errors.map(esc).join('<br>')}</div>` : ''}</div>`;
  }).join('') + `<p class="muted" style="font-size:11px;margin:0">Datos leídos de tu exchange ${esc(ago(d.t))}. «vs Coinbase»: cuánto más caro (+) o barato (−) es comprar en Robinhood frente al precio de Coinbase ahora.</p>`;
}
async function refreshDash() {
  const el = $('#dash_b'); if (!el) return;
  if (el.querySelector('#ds_f input:focus')) return; // no pisar lo que el usuario está escribiendo
  try {
    const d = await api('GET', '/api/dashboard'); el.innerHTML = dashHtml(d);
    const f = $('#ds_f');
    if (f) f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!f.ack.checked) return setMsg($('#ds_m'), 'Marca la confirmación de riesgo para continuar.');
      const usd = Number(f.usd.value);
      try { await quickStart({ symbol: 'AUTO', autoMode: 'pro', strategy: 'sma', usd, intervalMin: 60, fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60, stopLossPct: 8, takeProfitPct: 2, mode: 'live', connectionId: f.conn.value,
        maxOrderUsd: usd, maxDailyUsd: Math.min(d.limits.hardMaxDaily, usd * 12), maxPositions: 5, paperExchange: 'best', liveAck: true, enabled: true }); } catch (err) { setMsg($('#ds_m'), err.message); }
    });
  } catch (e) { el.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}
async function refreshLive(force = false) {
  const el = $('#live_b'); if (!el) return;
  try { el.innerHTML = liveHtml(await api('GET', `/api/exchange/live${force ? '?force=1' : ''}`)); } catch (e) { el.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}
function bindBotNow() {
  const off = $('#bn_off'); if (off) off.addEventListener('click', async () => { try { await api('POST', '/api/bot/kill'); state.tab = 'resumen'; loadTab(); } catch (e) { alert(e.message); } });
  const a = $('#bn_auto'); const d = $('#bn_demo');
  if (a) a.addEventListener('click', () => quickStart(AUTO_PRESET).catch((e) => alert(e.message)));
  if (d) d.addEventListener('click', () => quickStart(DEMO_PRESET).catch((e) => alert(e.message)));
}


// ---- Gráficos estilo Robinhood (SVG propio, sin librerías por la CSP) ----
const fmtT = (t, long) => new Date(t).toLocaleString('es', long ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' });
const priceFmt = (v) => money(v, v < 1 ? 5 : v < 100 ? 3 : 2);
// Dibuja la línea y deja que el dedo/mouse recorra la curva actualizando el valor de arriba (como Robinhood).
function drawChart(root, pts, o) {
  const H = 190; const P = 8;
  const g = $('.chg', root); const W = Math.max(240, Math.round(g.clientWidth || root.clientWidth || 340)); const vEl = $('.chv', root); const sEl = $('.chs', root);
  if (!pts || pts.length < 2) { g.innerHTML = '<p class="muted" style="margin:30px 0;text-align:center">Sin datos suficientes todavía.</p>'; return; }
  const vals = pts.map((p) => p.v); const lo = Math.min(...vals, o.base ?? Infinity); const hi = Math.max(...vals, o.base ?? -Infinity); const r = hi - lo || 1;
  const t0 = pts[0].t; const t1 = pts[pts.length - 1].t; const dt = t1 - t0 || 1;
  const X = (t) => P + ((t - t0) / dt) * (W - 2 * P); const Y = (v) => H - P - ((v - lo) / r) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const up = vals[vals.length - 1] >= (o.base ?? vals[0]);
  root.classList.toggle('up', up); root.classList.toggle('dn', !up);
  const marks = (o.marks || []).map((m) => `<circle class="${m.side === 'buy' ? 'mb' : 'ms'}" cx="${X(Math.max(t0, Math.min(t1, m.t))).toFixed(1)}" cy="${Y(m.price ?? vals[vals.length - 1]).toFixed(1)}" r="5"><title>${m.side === 'buy' ? 'Compra' : 'Venta'} ${money(m.usd)}</title></circle>`).join('');
  g.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}"><path class="ar" d="${line}L${X(t1).toFixed(1)},${H}L${X(t0).toFixed(1)},${H}Z"/>
    ${o.base !== undefined ? `<line class="base" x1="${P}" x2="${W - P}" y1="${Y(o.base).toFixed(1)}" y2="${Y(o.base).toFixed(1)}"/>` : ''}<path class="ln" d="${line}" vector-effect="non-scaling-stroke"/>${marks}
    <line class="xh" id="xh" y1="0" y2="${H}" x1="-9" x2="-9"/><circle class="dot" id="dt" r="5" cx="-9" cy="-9"/></svg>`;
  const rest = () => { vEl.textContent = o.fmt(vals[vals.length - 1]); sEl.innerHTML = o.sub(vals[vals.length - 1], null); };
  const at = (ev) => {
    const b = g.getBoundingClientRect(); const fx = Math.max(0, Math.min(1, (ev.clientX - b.left) / b.width));
    const t = t0 + fx * dt; let i = 0; while (i < pts.length - 1 && pts[i + 1].t <= t) i++;
    if (i < pts.length - 1 && t - pts[i].t > pts[i + 1].t - t) i++;
    const p = pts[i]; $('#xh', g).setAttribute('x1', X(p.t)); $('#xh', g).setAttribute('x2', X(p.t)); $('#dt', g).setAttribute('cx', X(p.t)); $('#dt', g).setAttribute('cy', Y(p.v));
    vEl.textContent = o.fmt(p.v); sEl.innerHTML = o.sub(p.v, p.t);
  };
  const clear = () => { for (const [id, a, v] of [['#xh', 'x1', -9], ['#xh', 'x2', -9], ['#dt', 'cx', -9], ['#dt', 'cy', -9]]) $(id, g).setAttribute(a, v); rest(); };
  g.onpointermove = at; g.onpointerdown = at; g.onpointerleave = clear; g.onpointerup = (e) => { if (e.pointerType !== 'mouse') clear(); };
  rest();
}
const chartShell = (id) => `<div class="chart" id="${id}"><div class="chv">…</div><div class="chs"></div><div class="chg"><p class="muted" style="margin:30px 0;text-align:center">Cargando gráfico…</p></div></div>`;
const pm = (n) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`);
function resTable(r) {
  const rows = [['24 h', '24h'], ['7 días', '7d'], ['30 días', '30d'], ['Total', 'total']].map(([l, k]) => { const x = r.periods[k];
    return `<tr><td>${l}</td><td class="r ${cls(x.pnl)}"><b>${pm(x.pnl)}</b></td><td class="r">${x.closed}</td><td class="r">${x.win_rate === null ? '—' : x.win_rate.toFixed(0) + ' %'}</td><td class="r ${x.max_drawdown < 0 ? 'neg' : ''}">${x.closed ? pm(x.max_drawdown) : '—'}</td></tr>`; }).join('');
  const mx = Math.max(0.01, ...r.daily.map((d) => Math.abs(d.pnl))); const W = 300; const bw = W / r.daily.length;
  const bars = r.daily.map((d, i) => { const h = Math.max(d.closed ? 2 : 0, (Math.abs(d.pnl) / mx) * 34); return `<rect x="${(i * bw + 2).toFixed(1)}" y="${d.pnl >= 0 ? (40 - h).toFixed(1) : 40}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${d.pnl >= 0 ? '#4ade80' : '#ff5d4d'}" opacity="${d.closed ? 1 : 0.15}"><title>${new Date(d.day).toLocaleDateString()}: ${pm(d.pnl)} (${d.closed} cerradas)</title></rect>`; }).join('');
  return `<div class="scroll"><table><thead><tr><th></th><th class="r">Ganó</th><th class="r">Cerr.</th><th class="r">Acierto</th><th class="r">Caída</th></tr></thead><tbody>${rows}</tbody></table></div>
    <svg viewBox="0 0 ${W} 80" width="100%" height="80" role="img" aria-label="Ganancia o pérdida realizada por día, últimos 14 días"><line x1="0" x2="${W}" y1="40" y2="40" stroke="#555" stroke-width="1"/>${bars}</svg>
    <div class="muted" style="font-size:11px">Últimos 14 días (por día, solo operaciones cerradas)</div>`;
}
async function loadResults() {
  const root = $('#res_b'); if (!root) return;
  try {
    const d = await api('GET', '/api/results');
    root.className = ''; root.innerHTML = `<div class="row" style="gap:6px;margin-bottom:6px"><span class="chip live">DINERO REAL</span></div>${d.real.periods.total.orders ? resTable(d.real) : '<p class="muted" style="margin:0 0 10px">Aún no hay operaciones reales.</p>'}
      <div class="row" style="gap:6px;margin:12px 0 6px"><span class="chip paper">PAPEL (simulado)</span></div>${d.paper.periods.total.orders ? resTable(d.paper) : '<p class="muted" style="margin:0">Aún no hay operaciones simuladas.</p>'}
      <p class="muted" style="font-size:11px;margin:10px 0 0">${esc(d.real.note)} Un porcentaje de aciertos alto no prueba rentabilidad: mira la ganancia, la caída (la peor racha de pérdida) y que pasen semanas.</p>`;
  } catch (e) { root.textContent = e.message; }
}
function bindVerify() {
  const go = $('#ver_go'); if (!go || go.dataset.b) return; go.dataset.b = '1';
  go.addEventListener('click', async () => {
    const box = $('#ver_b'); go.disabled = true; go.textContent = 'Consultando tu exchange…';
    try {
      const v = await api('GET', '/api/verify');
      const body = !v.exchanges.length ? '<p class="muted">No tienes ninguna conexión. Conecta Robinhood o Coinbase en «Conectar».</p>' : v.exchanges.map((e) => {
        if (!e.verified) return `<div class="vrow warn"><b>${esc(e.exchange)}</b> · NO VERIFICADO: ${esc(e.error || 'sin respuesta')}</div>`;
        const pos = e.positions.length ? e.positions.map((p) => `<div class="vl ${p.status}"><span>${p.status === 'ok' ? '✓' : p.status === 'info' ? 'ℹ' : '⚠'}</span><span><b>${esc(p.symbol.replace('-USD', ''))}</b> bot ${num(p.ledger_qty, 8)} · exchange ${num(p.exchange_qty, 8)}<br><em>${esc(p.msg)}</em></span></div>`).join('') : '<div class="vl ok"><span>✓</span><span>El bot no registra posiciones abiertas en este exchange.</span></div>';
        const o = e.orders; return `<div class="vrow ${e.ok ? 'good' : 'warn'}"><b>${esc(e.exchange)}</b> · ${e.ok ? 'TODO COINCIDE' : `${e.alerts} ALERTA(S)`} · saldo total ${money(e.balance_usd)}</div>${pos}
          <div class="vl ${o.mismatched ? 'alerta' : 'ok'}"><span>${o.mismatched ? '⚠' : '✓'}</span><span>Órdenes de 48 h: ${o.checked} del bot · ${o.matched} confirmadas por el exchange${o.unseen ? ` · ${o.unseen} no aparecen en sus últimas 15 (no verificadas)` : ''}${o.mismatched ? ` · ${o.mismatched} con diferencia` : ''}${o.issues.length ? `<br><em>${esc(o.issues.join(' | '))}</em>` : ''}${e.orders_error ? `<br><em>No se pudo leer su historial: ${esc(e.orders_error)}</em>` : ''}</span></div>`; }).join('');
      box.innerHTML = `${body}<p class="muted" style="font-size:11px;margin:8px 0">${esc(v.note)} · ${esc(ago(v.t))}</p><button class="btn small" id="ver_go" type="button">Verificar de nuevo</button>`; bindVerify();
    } catch (e) { box.innerHTML = `<p class="neg">${esc(e.message)}</p><button class="btn small" id="ver_go" type="button">Reintentar</button>`; bindVerify(); }
  });
}
async function loadProfit(mode) {
  const root = $('#pf_c'); if (!root) return;
  try {
    const d = await api('GET', `/api/profit?mode=${mode || ''}`);
    if (!d.started) { root.innerHTML = '<p class="muted" style="margin:0">Aún no se ha encendido el bot. Cuando lo enciendas aquí verás cuánto has ganado desde ese momento, con su curva.</p>'; return; }
    root.className = '';
    root.innerHTML = `<div class="chart" id="pf_ch"><div class="chv"></div><div class="chs"></div><div class="chg"></div></div>
      <div class="kpis" style="margin-top:10px"><div class="kpi"><div class="l">Cerrado</div><div class="v ${cls(d.realized)}" style="font-size:16px">${money(d.realized)}</div></div>
      <div class="kpi"><div class="l">Abierto</div><div class="v ${cls(d.unrealized)}" style="font-size:16px">${d.unrealized === null ? '—' : money(d.unrealized)}</div></div>
      <div class="kpi"><div class="l">Operaciones</div><div class="v" style="font-size:16px">${d.orders}</div></div></div>
      <p class="muted" style="font-size:11px;margin:6px 0 0">Ganancia = cambio de tu capital en el bot desde el encendido (${d.mode === 'live' ? 'REAL' : 'papel'}), incluye lo cerrado y lo abierto, ya con comisiones y spread.${d.partial ? ' Algunos precios históricos no estaban disponibles; la curva es aproximada.' : ''} No garantiza resultados futuros.</p>`;
    const ch = $('#pf_ch');
    const sub = (v, t) => `<span class="${cls(v)}">${d.pct !== null ? `${v >= 0 ? '+' : ''}${(d.peak_capital > 0 ? (v / d.peak_capital) * 100 : 0).toFixed(2)} %` : ''}</span> ${t ? fmtT(t, true) : `desde que se encendió · ${esc(ago(d.start))}`}`;
    drawChart(ch, d.curve.map((p) => ({ t: p.t, v: p.v })), { base: 0, label: 'Ganancia desde el encendido', fmt: (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`, sub });
  } catch (e) { root.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}
const chartState = { sym: null, range: '1D' };
async function loadPrice() {
  const root = $('#pc_c'); if (!root) return;
  try {
    const d = await api('GET', `/api/chart?symbol=${encodeURIComponent(chartState.sym)}&range=${chartState.range}`);
    const base = d.symbol.replace('-USD', '');
    $('#pc_t', root).innerHTML = '<div class="chv"></div><div class="chs"></div><div class="chg"></div>';
    const ch = $('#pc_t', root); ch.className = 'chart';
    const sub = (v, t) => { const c = (v / d.open - 1) * 100; return `<span class="${cls(c)}">${v >= d.open ? '▲' : '▼'} ${money(Math.abs(v - d.open), v < 1 ? 5 : 2)} (${pc(c, 2)})</span> ${t ? fmtT(t, true) : `${esc(base)} · ${chartState.range}`}`; };
    $('#pc_rw').className = `chart ${d.price >= d.open ? 'up' : 'dn'}`;
    drawChart(ch, d.points, { base: d.open, label: `Precio de ${base}`, fmt: priceFmt, sub, marks: d.mine });
    $('#pc_hl', root).textContent = `Máx ${priceFmt(d.hi)} · Mín ${priceFmt(d.lo)}${d.mine.length ? ' · puntos = tus compras (verde) y ventas (rojo)' : ''}`;
  } catch (e) { $('#pc_t', root).innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
}
function priceCardHtml(bn) {
  const syms = [...new Set([...(bn.holdings || []).map((h) => h.symbol), ...(bn.symbol && bn.symbol !== 'AUTO' ? [bn.symbol] : []), 'BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD'])].slice(0, 8);
  if (!chartState.sym || !syms.includes(chartState.sym)) chartState.sym = syms[0];
  return `<div class="symsel" id="pc_s">${syms.map((x) => `<button type="button" data-sym="${esc(x)}" class="${x === chartState.sym ? 'on' : ''}">${esc(x.replace('-USD', ''))}</button>`).join('')}</div>
    <div id="pc_t" class="chart"><div class="chv">…</div><div class="chs"></div><div class="chg"></div></div>
    <div class="chart" id="pc_rw"><div class="rng" id="pc_r">${['1D', '1W', '1M', '3M'].map((r) => `<button type="button" data-r="${r}" class="${r === chartState.range ? 'on' : ''}">${r === '1W' ? '1S' : r}</button>`).join('')}</div></div>
    <div class="muted" style="font-size:12px;margin-top:6px" id="pc_hl"></div>`;
}
function bindPrice() {
  const s = $('#pc_s'); const r = $('#pc_r'); if (!s || !r) return;
  s.onclick = (e) => { const b = e.target.closest('button[data-sym]'); if (!b) return; chartState.sym = b.dataset.sym; for (const x of s.children) x.classList.toggle('on', x === b); loadPrice(); };
  r.onclick = (e) => { const b = e.target.closest('button[data-r]'); if (!b) return; chartState.range = b.dataset.r; for (const x of r.children) x.classList.toggle('on', x === b); loadPrice(); };
  loadPrice();
}

// ---- Cerebro en vivo: red de nodos animada con datos REALES (qué vigila, qué tiene, qué decidió). Sin cifras inventadas. ----
function brainViz(root, d0) {
  const cv = $('canvas', root); const ctx = cv.getContext('2d'); const dpr = Math.min(2, window.devicePixelRatio || 1);
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COL = { held: '#4ade80', ok: '#ffd60a', idle: '#8a8776', off: '#4a4a44', hot: '#ff5d4d', buy: '#4ade80', keep: '#ffd60a', drop: '#ff5d4d' };
  let d = d0; let W = 0; let H = d.octopus ? 300 : 250; const nodes = new Map(); let parts = [];
  const TAU = Math.PI * 2;
  // Reparte los nodos alrededor (los más fuertes arriba) y conserva los que ya existen para que se deslicen en vez de saltar.
  const layout = (nd) => {
    const sorted = nd.nodes.map((n, i) => ({ ...n, i })).sort((x, y) => (y.w || 0) - (x.w || 0) || x.i - y.i);
    const seen = new Set();
    sorted.forEach((n, i) => {
      const ta = (i / sorted.length) * TAU - Math.PI / 2; seen.add(n.label); const cur = nodes.get(n.label);
      if (cur) Object.assign(cur, { kind: n.kind, sub: n.sub, tw: n.w || 0, ta, gone: false });
      else nodes.set(n.label, { label: n.label, kind: n.kind, sub: n.sub, w: 0, tw: n.w || 0, a: ta, ta, ph: Math.random() * TAU, al: 0, gone: false });
    });
    for (const [k, n] of nodes) if (!seen.has(k)) n.gone = true;
    parts = [...nodes.values()].filter((n) => !n.gone && n.kind !== 'off' && !(n.kind === 'idle' && d.octopus)).flatMap((n) => Array.from({ length: ['held', 'ok', 'buy'].includes(n.kind) ? 3 : 1 }, (_, k) => ({ n, t: Math.random(), sp: (nd.live ? 0.0035 : 0.0012) * (0.7 + Math.random() * 0.8), out: (n.kind === 'held' || n.kind === 'buy') && k === 0 })));
  };
  const size = () => { H = d.octopus ? 300 : 250; cv.style.height = `${H}px`; W = cv.clientWidth || 340; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const pos = (n, t) => { const rx = W * (d.octopus ? 0.29 : 0.38); const ry = H * 0.34; const w = Math.sin(t / 1400 + n.ph) * 3; return [W / 2 + Math.cos(n.a) * rx + w, H / 2 + Math.sin(n.a) * ry + w]; };
  const curve = (n, u, t) => {
    const cx = W / 2; const cy = H / 2; const [x, y] = pos(n, t); const qx = (cx + x) / 2 + (y - cy) * 0.12; const qy = (cy + y) / 2 - (x - cx) * 0.12;
    let px = (1 - u) * (1 - u) * cx + 2 * (1 - u) * u * qx + u * u * x; let py = (1 - u) * (1 - u) * cy + 2 * (1 - u) * u * qy + u * u * y;
    if (d.octopus) { const dx = x - cx; const dy = y - cy; const L = Math.hypot(dx, dy) || 1; const wv = Math.sin(u * 7 - t / 420 + n.ph) * 5 * Math.sin(u * Math.PI) * (n.kind === 'idle' ? 0.5 : 1); px += (-dy / L) * wv; py += (dx / L) * wv; }
    return [px, py];
  };
  const frame = (t) => {
    if (!document.body.contains(cv)) return;
    ctx.clearRect(0, 0, W, H); const cx = W / 2; const cy = H / 2; const oct = !!d.octopus;
    for (const [k, n] of nodes) { // animación suave hacia el objetivo
      n.w += (n.tw - n.w) * 0.07; let da = n.ta - n.a; da = Math.atan2(Math.sin(da), Math.cos(da)); n.a += da * 0.06; n.al += ((n.gone ? 0 : 1) - n.al) * 0.08;
      if (n.gone && n.al < 0.03) { nodes.delete(k); parts = parts.filter((p) => p.n !== n); }
    }
    for (const n of nodes.values()) {
      const col = COL[n.kind] || COL.idle; const w = oct ? 1 + 6 * Math.max(0, Math.min(1, n.w)) : 1;
      ctx.strokeStyle = n.kind === 'off' ? 'rgba(120,120,110,.18)' : oct ? col : 'rgba(255,214,10,.22)'; ctx.globalAlpha = n.al * (oct ? (n.kind === 'idle' ? 0.28 : 0.9) : 1); ctx.lineCap = 'round'; ctx.lineWidth = oct ? Math.max(1, w) : 1;
      ctx.beginPath(); for (let i = 0; i <= 26; i++) { const [px, py] = curve(n, i / 26, t); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.stroke(); ctx.globalAlpha = 1;
    }
    for (const p of parts) {
      p.t += p.sp * (d.live ? 1 + (p.n.tw || 0) * 1.5 : 1); if (p.t > 1) p.t = 0; const u = p.out ? p.t : 1 - p.t; const [px, py] = curve(p.n, u, t);
      ctx.fillStyle = p.out ? '#4ade80' : '#ffd60a'; ctx.globalAlpha = 0.9 * p.n.al; ctx.beginPath(); ctx.arc(px, py, oct ? 2.4 : 1.9, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
    }
    for (const n of nodes.values()) {
      const [x, y] = pos(n, t); const c = COL[n.kind] || COL.idle; const r = (n.kind === 'held' || n.kind === 'buy' ? 6 : 4.5) * (0.6 + 0.4 * n.al);
      ctx.globalAlpha = n.al;
      if (n.kind !== 'off' && n.kind !== 'idle') { ctx.fillStyle = c; ctx.globalAlpha = 0.16 * n.al; ctx.beginPath(); ctx.arc(x, y, r + 6 + Math.sin(t / 500 + n.ph) * 2, 0, TAU); ctx.fill(); ctx.globalAlpha = n.al; }
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      const right = Math.cos(n.a) > 0.25; const left = Math.cos(n.a) < -0.25; const mid = !right && !left;
      ctx.fillStyle = n.kind === 'off' ? '#6b6a60' : '#ece9d8'; ctx.font = '700 11px ui-monospace,Menlo,monospace'; ctx.textAlign = right ? 'left' : left ? 'right' : 'center';
      const tx = x + (right ? 10 : left ? -10 : 0); const ty = y + (mid ? (Math.sin(n.a) > 0 ? 19 : -13) : 4);
      ctx.fillText(n.label, tx, ty);
      if (n.sub) { ctx.fillStyle = c; ctx.globalAlpha = 0.9 * n.al; ctx.font = '600 9px ui-monospace,Menlo,monospace'; ctx.fillText(n.sub, tx, ty + 11); }
      ctx.globalAlpha = 1;
    }
    const pr = 14 + Math.sin(t / 380) * (d.live ? 3 : 1);
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, pr * 2.6); g.addColorStop(0, 'rgba(255,214,10,.55)'); g.addColorStop(1, 'rgba(255,214,10,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, pr * 2.6, 0, TAU); ctx.fill();
    if (oct) {
      ctx.fillStyle = '#ffd60a'; ctx.beginPath(); ctx.ellipse(cx, cy - 2, 18, 16 + Math.sin(t / 500) * 1, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0b0b0e'; for (const ex of [-6.5, 6.5]) { ctx.beginPath(); ctx.arc(cx + ex, cy - 3, 3.4, 0, TAU); ctx.fill(); }
      ctx.fillStyle = '#ffd60a'; for (const ex of [-6.5, 6.5]) { ctx.beginPath(); ctx.arc(cx + ex + Math.sin(t / 900) * 0.9, cy - 4, 1.1, 0, TAU); ctx.fill(); }
    } else {
      ctx.fillStyle = '#ffd60a'; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0b0b0e'; ctx.font = '700 8px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.fillText(d.center, cx, cy + 3);
    }
    if (!still) requestAnimationFrame(frame);
  };
  size(); layout(d); for (const n of nodes.values()) { n.w = n.tw; n.a = n.ta; n.al = 1; }
  new ResizeObserver(() => { size(); if (still) frame(0); }).observe(cv); requestAnimationFrame(frame);
  return { update(nd) { const was = d.octopus; d = nd; if (was !== d.octopus) size(); layout(nd); if (still) frame(0); } };
}
const tagOf = (txt) => (/mantiene|vigila|espera|pausa|descansa|freno|límite|sin saldo/i.test(txt) && !/^(compra|vende)\s/i.test(txt) ? ['VIGILA', 'hold'] : /compra|buy/i.test(txt) && !/vende|vend[ií]|sell/i.test(txt) ? ['COMPRA', 'buy'] : /vend|stop din|sell|rota:|toma de ganancia|tendencia rota/i.test(txt) ? ['VENTA', 'sell'] : ['NOTA', '']);
const vizStat = (d) => d.stats.map((x) => `<div><b>${esc(x[1])}</b>${esc(x[0])}</div>`).join('');
const vizRows = (d) => (d.rows && d.rows.length ? d.rows.map((r) => `<div class="br ${r.kind}"><b>${esc(r.sym)}</b><span>${esc(r.state)}</span><span class="num">${r.score ? r.score.toFixed(1) : '—'}</span><span class="num">${esc(r.note)}</span></div>`).join('') : '');
const vizStream = (d) => d.stream.slice(0, 14).map((x) => { const [tg, c] = tagOf(x.text); return `<div><span class="tg ${c}">${tg}</span>${x.t ? `<span>${esc(ago(x.t))} · </span>` : ''}${esc(x.text)}</div>`; }).join('') || '<div>Esperando la primera decisión…</div>';
const TH_TAG = { pass: 'TRASPASO', buy: 'COMPRA', sell: 'VENTA', risk: 'FRENO', hold: 'VIGILA' };
const vizWhy = (d) => (d.thoughts || []).map((x) => `<div class="w ${x.k}"><b>${x.big ? 'COMPRA GRANDE' : TH_TAG[x.k] || 'NOTA'}</b> ${esc(x.text)}</div>`).join('');
const briefBtn = (d) => (d.city && voice.supported ? '<button type="button" class="bbrief">🎙 Informe del Cerebro</button>' : '');
const micBtn = (d) => ((d.octopus || d.ufo) && voice.supported && (window.SpeechRecognition || window.webkitSpeechRecognition) ? '<button type="button" class="bmic" aria-label="Preguntar por voz">🎤 Hablar con el Cerebro</button>' : '');
const voiceLbl = () => (voice.on ? '🔊 Voz activa' : '🔈 Toca para oírlo');
function vizHtml(d, id) {
  return `<div class="bviz" id="${id}"><canvas aria-label="${esc(d.caption)}"></canvas><span class="bcap">${esc(d.caption)}</span>${briefBtn(d)}${micBtn(d)}${(d.octopus || d.city || d.ufo) && voice.supported ? `<button type="button" class="bvoice${voice.on ? ' on' : ''}" aria-pressed="${voice.on}">${voiceLbl()}</button>` : ''}
    <div class="bstat">${vizStat(d)}</div><div class="brows" ${d.rows && d.rows.length ? '' : 'hidden'}>${vizRows(d)}</div>
    ${d.city ? '<div class="bdetail" hidden></div>' : ''}<div class="bwhy" ${d.thoughts && d.thoughts.length ? '' : 'hidden'}>${vizWhy(d)}</div><div class="bstream">${vizStream(d)}</div><div class="bappr">${esc(d.approval)}</div></div>`;
}
function vizFill(root, d) {
  $('.bcap', root).textContent = d.caption; $('.bstat', root).innerHTML = vizStat(d); const r = $('.brows', root); r.innerHTML = vizRows(d); r.hidden = !(d.rows && d.rows.length); $('.bstream', root).innerHTML = vizStream(d);
  const w = $('.bwhy', root); if (w) { w.innerHTML = vizWhy(d); w.hidden = !(d.thoughts && d.thoughts.length); }
}
const agoS = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'ahora' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const OSTATE = { compró: ['buy', 'compró'], listo: ['buy', 'listo p/comprar'], fuerte: ['held', 'fuerte'], mantiene: ['held', 'mantiene'], débil: ['drop', 'débil'], suelta: ['drop', 'suelta'], vendió: ['drop', 'vendió'], soltó: ['drop', 'soltó'] };
function botViz(bn) {
  const base = (s) => s.replace('-USD', '');
  const held = (bn.holdings || []).map((h) => base(h.symbol)); const ok = ((bn.scanner && bn.scanner.qualified) || []).map((q) => base(q.symbol));
  const seen = new Set(); const nodes = [];
  const add = (l, k, extra = {}) => { if (!seen.has(l) && nodes.length < 14) { seen.add(l); nodes.push({ label: l, kind: k, ...extra }); } };
  const octo = bn.octopus && bn.octopus.items && bn.symbol === 'AUTO' ? bn.octopus : null;
  if (octo) {
    const tot = (bn.holdings || []).reduce((x, h) => x + (h.value || 0), 0) || 0; const mx = Math.max(0.0001, ...octo.items.map((i) => i.score || 0));
    const hv = new Map((bn.holdings || []).map((h) => [base(h.symbol), h.value || 0]));
    for (const it of octo.items) {
      const [kind, txt] = OSTATE[it.state] || ['idle', it.state]; const l = base(it.symbol);
      const share = tot > 0 && hv.has(l) ? hv.get(l) / tot : 0;
      add(l, kind, { w: it.held ? Math.max(0.25, share) : (it.score || 0) / mx * 0.6, sub: `${txt.split(' ')[0]}${kind === 'held' && it.gain_pct !== undefined ? ` ${it.gain_pct >= 0 ? '+' : ''}${it.gain_pct.toFixed(1)}%` : ''}` });
    }
    held.forEach((l) => add(l, 'held', { w: 0.4, sub: 'tiene' }));
  } else { held.forEach((l) => add(l, 'held')); ok.forEach((l) => add(l, 'ok')); }
  ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK'].forEach((l) => add(l, 'idle', { w: 0.05 }));
  const stream = [];
  if (bn.last) { for (const a of bn.last.auto || []) stream.push({ t: bn.last.t, text: a }); stream.push({ t: bn.last.t, text: bn.last.reason }); }
  for (const o of bn.recent || []) if (o.status === 'ok') stream.push({ t: o.t, text: `${o.side === 'buy' ? 'compra' : 'vende'} ${base(o.symbol)} ${money(o.usd)}${o.mode === 'live' ? ' (REAL)' : ' (papel)'}` });
  const rg = octo && octo.regime ? ({ bull: 'alcista', bear: 'bajista', volatile: 'volátil', range: 'lateral', unknown: 'sin datos' }[octo.regime] || octo.regime) : null;
  const scouts = (() => { const nw = octo && octo.news; const top = octo && octo.items ? [...octo.items].sort((x, y) => (y.score || 0) - (x.score || 0))[0] : null; const q = (bn.scanner && bn.scanner.qualified) ? bn.scanner.qualified.length : 0;
    return [{ name: 'NOTICIAS', col: '#5ac8fa', val: nw ? (nw.risk_off ? `freno · ${nw.negatives} negativas` : 'sin alertas') : 'leyendo…' },
      { name: 'MERCADO', col: '#c4a8ff', val: rg || 'analizando…' },
      { name: 'MOVIMIENTOS', col: '#4ade80', val: top ? `${base(top.symbol)} ${top.score ? top.score.toFixed(1) : ''}` : 'escaneando…' },
      { name: 'RIESGO', col: '#ff9f6b', val: octo && octo.risk ? String(octo.risk) : 'normal' },
      { name: 'COSTOS', col: '#ffd60a', val: `${q} validadas` }]; })();
  const rows = octo ? octo.items.map((it) => ({ sym: base(it.symbol), state: (OSTATE[it.state] || [0, it.state])[1], kind: (OSTATE[it.state] || ['idle'])[0], score: it.score, why: it.why || '', conf: it.conf, ev: it.ev || [], note: it.held ? `${it.gain_pct >= 0 ? '+' : ''}${(it.gain_pct || 0).toFixed(2)} %` : it.edge ? `${it.edge.toFixed(1)}× costo` : '' })) : null;
  return { center: 'IA', ufo: true, scouts, nodes, stream, rows, thoughts: octo ? (octo.thoughts || []) : [], ot: octo ? octo.t : 0, live: bn.enabled, octopus: !!octo, caption: bn.enabled ? 'Superintelligence · en vivo' : 'Cerebro · apagado',
    stats: [['posiciones', held.length], ['validadas', ok.length], ['mercado', rg || '—'], ['revisó', agoS(bn.last_run)]],
    approval: 'Tú mandas: topes por orden y por día, botón de apagado y trading real solo con tu confirmación.' };
}
// Qué hace cada agente y a quién le pasa su trabajo (así la ciudad cuenta cómo se coordinan).
const COORD = {
  market_intel: ['lee el mercado global y el libro de órdenes de Coinbase para saber si el mercado está alcista, bajista o lateral', 'opportunity_scanner', 'el régimen y los costos reales'],
  opportunity_scanner: ['recorre las criptos grandes y prueba una estrategia en cada una con los costos de Coinbase y Robinhood', 'paper_lab', 'las criptos que califican'],
  paper_lab: ['practica con un millón virtual para ver qué estrategias ganan de verdad', 'trading_improvement', 'las estrategias campeonas'],
  trading_improvement: ['propone cambios a la configuración del bot según lo que aprendió el laboratorio', null, 'sus propuestas a ti, que decides'],
  ml_models: ['entrena modelos de predicción y solo los activa si le ganan al azar en datos que no vio', 'trading_improvement', 'los modelos candidatos'],
  problem_processing: ['procesa los problemas que reportan los clientes y propone arreglos', null, 'sus propuestas a ti, que decides'],
  legal_watch: ['vigila que los avisos legales y los datos de la empresa estén completos; no es un abogado, deja la lista para el tuyo', null, 'avisos para ti y para tu abogado'],
  superintendent: ['supervisa que el escáner, las noticias y los bots sigan corriendo', null, 'alertas de estado para ti'],
  ui_landing: ['revisa la landing y la app (título, llamada a la acción, peso y traducciones) y propone mejoras', null, 'sus hallazgos para ti'],
  client_support: ['agrupa los problemas de los clientes y deja respuestas listas para que tú las envíes', null, 'respuestas sugeridas para ti'],
  ia_explainer: ['explica con IA, en palabras simples, qué hizo el Cerebro y por qué (solo con datos reales)', null, 'una explicación en lenguaje simple'],
  owner_analytics: ['analiza el negocio: clientes, uso y errores', null, 'avisos para ti'],
};
// Informe del Cerebro: lo que los agentes encontraron sobre trading y oportunidades (solo datos reales guardados; sin promesas).
function briefing(b) {
  const out = []; const pc1 = (x) => `${x >= 0 ? 'más ' : 'menos '}${Math.abs(x).toFixed(1)} por ciento`;
  out.push(`Informe del Cerebro. ${b.agents.filter((a) => a.enabled).length} agentes trabajando.`);
  const sc = b.scanner;
  if (sc && sc.items) {
    const q = sc.items.filter((i) => i.qualified);
    if (q.length) {
      out.push(`Oportunidades: el Escáner revisó ${sc.scanned} criptos y ${q.length} califican.`);
      for (const i of q.slice(0, 3)) { const v = i[i.cheaper] || i.coinbase || i.robinhood; out.push(`${i.symbol.replace('-USD', '')}: estrategia ${i.label}${v && v.ret !== undefined ? `, en simulación ${pc1(v.ret)} frente a ${pc1(v.bh)} de comprar y mantener` : ''}${i.cheaper ? `. Conviene operarla en ${i.cheaper}, que cobra menos` : ''}.`); }
    } else out.push(`Oportunidades: el Escáner revisó ${sc.scanned} criptos y ninguna cumple todas las reglas ahora. Por eso no recomienda comprar nada nuevo; prefiero esperar a una señal clara.`);
  } else out.push('Oportunidades: el Escáner todavía no ha corrido.');
  const lab = b.lab || {}; const ch = Object.entries(lab.champions || {});
  if (ch.length) for (const [sym, c] of ch.slice(0, 2)) out.push(`Laboratorio de papel: en ${sym.replace('-USD', '')} la estrategia campeona es ${c.label}, ${c.validated ? 'ya validada con datos que no vio' : 'todavía sin validar'}.`);
  else out.push('Laboratorio de papel: aún no hay estrategia campeona; sigue practicando con dinero virtual.');
  const ml = (b.models || []).filter((m) => m.active || m.candidate);
  if (ml.length) out.push(`Modelos: ${ml.map((m) => `${m.symbol.replace('-USD', '')} ${m.active ? 'activo' : 'candidato sin activar'}`).join(', ')}.`);
  if (b.pending.length) out.push(`Esperan tu decisión ${b.pending.length} propuesta${b.pending.length > 1 ? 's' : ''}: ${b.pending.slice(0, 3).map((p) => p.title).join('; ')}.`);
  else out.push('No hay propuestas pendientes para ti.');
  out.push('Todo esto es simulación y análisis, no una promesa de ganancia. Solo tú apruebas los cambios.');
  return out;
}
function agentsViz(b) {
  const st = new Map((b.agent_stats || []).map((x) => [x.name, x])); const lastNote = new Map();
  for (const r of (b.runs || []).slice(0, 4)) for (const a of r.agents) if (!lastNote.has(a.agent) && (a.notes || []).length) lastNote.set(a.agent, a.notes[0]);
  const detail = (a, x) => ({ name: a.name, label: a.label || a.name, state: !a.available ? 'próximamente' : a.enabled ? 'activo' : 'apagado', stats: x, notes: (() => { const o = []; for (const r of (b.runs || []).slice(0, 6)) for (const q of r.agents) if (q.agent === a.name) for (const n of (q.notes || []).slice(0, 2)) o.push({ t: r.t, text: n }); return o.slice(0, 4); })(), pending: (b.pending || []).filter((p) => p.agent === a.name).map((p) => p.title) });
  const nodes = b.agents.map((a) => { const x = st.get(a.name) || {}; const mx = Math.max(1, ...b.agents.map((q) => (st.get(q.name) || {}).runs || 0)); return { label: (a.label || a.name).split(' ')[0].slice(0, 13), kind: !a.available ? 'off' : a.enabled ? 'ok' : 'idle', w: ((x.runs || 0) / mx) * 0.6 + Math.min(0.4, (x.created || 0) / 20), sub: lastNote.get(a.name) || `${x.runs || 0} corridas · ${x.created || 0} propuestas`, detail: detail(a, x), name: a.name, say: (() => { const c = COORD[a.name]; const nt = lastNote.get(a.name); const tgt = c && c[1] ? (b.agents.find((q) => q.name === c[1]) || {}).label : null; return `${a.label || a.name}${a.enabled ? '' : ', apagado'}: ${c ? c[0] : 'agente en preparación'}.${nt ? ` Lo último que reportó: ${String(nt).slice(0, 170)}.` : ' Todavía no ha reportado nada.'}${c && a.enabled ? ` Le pasa ${c[2]}${tgt ? ` a ${tgt}` : ''}.` : ''}`; })(), to: (() => { const c = COORD[a.name]; return c && c[1] ? b.agents.findIndex((q) => q.name === c[1]) : -1; })() }; });
  const stream = [];
  for (const r of (b.runs || []).slice(0, 4)) for (const a of r.agents) for (const n of (a.notes || []).slice(0, 2)) stream.push({ t: r.t, text: `${a.agent}: ${n}` });
  return { center: 'DIR', nodes, pending: b.pending.length, city: true, briefing: briefing(b), thoughts: b.agents.filter((a) => a.enabled && COORD[a.name]).map((a) => { const c = COORD[a.name]; const t = c[1] ? (b.agents.find((q) => q.name === c[1]) || {}).label : 'ti'; return { k: 'pass', text: `${a.label} → ${t || 'ti'}: le pasa ${c[2]}.` }; }).slice(0, 7), directorSay: `Director al habla. ${b.agents.filter((a) => a.enabled).length} agentes están trabajando${b.pending.length ? ` y ${b.pending.length} propuesta${b.pending.length > 1 ? 's esperan' : ' espera'} tu decisión. Solo tú las apruebas` : ', sin propuestas pendientes'}. Última corrida ${agoS(b.last_run) === 'ahora' ? 'ahora mismo' : 'hace ' + agoS(b.last_run)}.`, stream: stream.slice(0, 14), live: true, caption: 'Director + agentes',
    stats: [['agentes activos', b.agents.filter((a) => a.enabled).length], ['pendientes tuyos', b.pending.length], ['versión', 'v' + b.brain_version], ['última corrida', ago(b.last_run)]],
    approval: b.pending.length ? `Solo tú apruebas: ${b.pending.length} propuesta(s) esperan tu decisión.` : 'Solo tú apruebas los cambios críticos. Nada pendiente ahora.' };
}

// Los agentes viven en una ciudad 3D; si el 3D falla, cae a la red de nodos.
const agentSummary = (n) => { const x = n.detail.stats || {}; return `${n.detail.label}: ${n.detail.state}. ${x.runs || 0} corridas, ${x.created || 0} propuestas, ${x.applied || 0} aplicadas${n.detail.pending.length ? `, y ${n.detail.pending.length} esperando tu decisión` : ''}.${n.detail.notes[0] ? ` Última nota: ${n.detail.notes[0].text}` : ''}`; };
function showAgent(r, n) {
  const box = $('.bdetail', r); if (!box) return; const dt = n.detail; const x = dt.stats || {};
  box.hidden = false; box.innerHTML = `<div class="dh"><b>${esc(dt.label)}</b><span class="dst ${dt.state === 'activo' ? 'on' : ''}">${esc(dt.state)}</span></div>
    <div class="dg"><span><b>${x.runs || 0}</b>corridas</span><span><b>${x.created || 0}</b>propuestas</span><span><b>${x.applied || 0}</b>aplicadas</span><span><b>${x.rejected || 0}</b>rechazadas</span></div>
    ${dt.pending.length ? `<div class="dp"><em>Esperan tu decisión</em>${dt.pending.map((t) => `<div>• ${esc(t)}</div>`).join('')}</div>` : ''}
    ${dt.notes.length ? `<div class="dn"><em>Últimas notas</em>${dt.notes.map((q) => `<div>${esc(ago(q.t))} · ${esc(q.text)}</div>`).join('')}</div>` : '<div class="dn"><em>Sin notas todavía</em></div>'}`;
}
// Los agentes viven en una ciudad 3D; si el 3D falla, cae a la red de nodos.
async function mountCity(r, d) {
  if (!r) return;
  try {
    const m = await import('/city3d.js'); if (!document.body.contains(r)) return;
    m.createCity3D($('canvas', r), d, { onSay: (t, hi) => voice.say(t, hi), onPick: (i) => { const n = d.nodes[i]; showAgent(r, n); voice.say(n.say || agentSummary(n), true); } });
    r.classList.add('is3d'); bindVoice(r, { ot: 0 });
    const bb = $('.bbrief', r); if (bb) bb.onclick = () => { if (!voice.on) { voice.set(true); const vb = $('.bvoice', r); if (vb) { vb.classList.add('on'); vb.textContent = voiceLbl(); } } const box = $('.bdetail', r); if (box) { box.hidden = false; box.innerHTML = `<div class="dh"><b>Informe del Cerebro</b></div><div class="dn">${d.briefing.map((x) => `<div>${esc(x)}</div>`).join('')}</div>`; } voice.sayAll(d.briefing); };
    if (voice.on) voice.sayAll([d.directorSay, ...d.briefing.slice(1, 3)]); else voice.say(d.directorSay, false);
  } catch { brainViz(r, d); }
}
let vizCtl = null; let vizMode = '';
// Con el bot en AUTO el Cerebro es un OVNI con IA en 3D que recorre el mapa de criptos; si no, la red de nodos. Si el 3D falla, cae a la red.
async function mountViz(bn) {
  const r = $('#bz_v'); if (!r) return; const d = botViz(bn); lastD = d; lastBn = bn;
  if (d.octopus || d.ufo) { try { const m = await import('/octo3d.js'); if (!document.body.contains(r)) return; vizCtl = m.createOcto3D($('canvas', r), d, { onSay: (t, hi) => voice.say(t, hi) }); bindVoice(r, d); vizMode = '3d'; r.dataset.on = '1'; r.classList.add('is3d'); return; } catch { /* usa la red */ } }
  vizCtl = brainViz(r, d); vizMode = '2d'; r.dataset.on = '1'; r.classList.remove('is3d');
}
// Voz: botón de activar/silenciar y narración de lo nuevo que decide el pulpo (solo lo que llegó después de abrir la pantalla).
let thoughtSeen = 0;
function bindVoice(r, d) {
  if (!thoughtSeen && d.ot) thoughtSeen = d.ot;
  const b = $('.bvoice', r); if (!b || b.dataset.b) return; b.dataset.b = '1';
  b.onclick = () => { if (voice.on && Date.now() - lastSpoke < 25000) autoPace.muted(); voice.set(!voice.on); b.classList.toggle('on', voice.on); b.setAttribute('aria-pressed', String(voice.on)); b.textContent = voiceLbl(); startAuto(); };
  const m = $('.bmic', r); if (m && !m.dataset.b) { m.dataset.b = '1'; m.onclick = () => { if (convoOn) stopConvo(m); else startConvo(m, b); }; }
  startAuto();
}

// ---- Conversación por voz en vivo: escucha, responde hablando y vuelve a escuchar hasta que digas "basta" o haya silencio. ----
let convoOn = false; let convoMiss = 0; let convoUnsub = null; let convoListening = false; let lastBn = null;
const micLbl = (on) => (on ? '🎤 Escuchando… (toca para parar)' : '🎤 Hablar con el Cerebro');
function stopConvo(m) { convoOn = false; convoListening = false; if (convoUnsub) { convoUnsub(); convoUnsub = null; } if (m) { m.classList.remove('on'); m.textContent = micLbl(false); } }
// Pedirle al Cerebro que compre cuando esté listo: SOLO en papel. Con dinero real no se opera por voz (cualquiera cerca del micrófono podría hablar): el Cerebro real ya compra solo con tus topes.
async function voiceBuy() {
  const bn = lastBn || {}; const d = lastD || {};
  if (bn.mode === 'live') return 'Con dinero real no compro por voz. El Cerebro real ya compra solo, con tus topes, apenas algo cumple todas las reglas. Para cambiar algo, tócalo en pantalla.';
  try {
    if (!bn.enabled) { await api('PUT', '/api/bot', AUTO_PRESET); return 'Listo: encendí el Cerebro en modo papel. Compraré apenas algo cumpla todas las reglas, y te cuento por qué.'; }
    await api('POST', '/api/bot/evaluate-now'); const r = (d.rows || []).find((x) => /listo/i.test(x.state || ''));
    return r ? `Revisé ahora. ${r.sym} está lista${r.conf ? ` con confianza ${r.conf} por ciento` : ''}; compro si cumple tus topes.` : 'Revisé ahora. Todavía ninguna cripto cumple todas las reglas; compro apenas una cumpla.';
  } catch (e) { return `No pude hacerlo: ${e.message}`; }
}
async function answerVoice(txt) {
  const it = intentOf(txt); if (it === 'mute' || it === 'none') return it;
  if (it === 'buy') return voiceBuy();
  const pf = $('#pf_c'); const profit = pf ? pf.innerText.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  return answerFor(it, lastD || {}, lastBn || {}, { profit, future: lastFuture });
}
function listenLoop(m, b) {
  if (!convoOn || convoListening) return; convoListening = true; let got = false;
  const ok = listenOnce(lang(), async (txt) => {
    got = true; convoMiss = 0; const out = await answerVoice(txt);
    if (out === 'mute') { stopConvo(m); if (b) { voice.set(false); b.classList.remove('on'); b.textContent = voiceLbl(); } autoPace.muted(); return; }
    if (out !== 'none') voice.say(out, true);
  }, () => { convoListening = false; if (!convoOn) return; if (!got && ++convoMiss >= 3) { stopConvo(m); return; } if (!got) setTimeout(() => listenLoop(m, b), 400); });
  if (!ok) { convoListening = false; stopConvo(m); voice.say('Tu navegador no deja escuchar por voz aquí.', true); }
}
function startConvo(m, b) {
  if (!voice.on) { voice.set(true); if (b) { b.classList.add('on'); b.textContent = voiceLbl(); } }
  convoOn = true; convoMiss = 0; m.classList.add('on'); m.textContent = micLbl(true);
  // Mientras el Cerebro habla no se escucha (evita oírse a sí mismo); al terminar vuelve a escuchar.
  convoUnsub = voice.subscribe((s) => { if (convoOn && !s.speaking && !convoListening) setTimeout(() => { if (convoOn && !voice.speakingNow) listenLoop(m, b); }, 500); });
  voice.say(lang() === 'en' ? 'I am listening. Ask me anything about what I am doing.' : 'Te escucho. Pregúntame lo que quieras sobre lo que hago.', true);
}
// Narración automática: cada cierto rato el Cerebro cuenta qué hace, noticias y por qué compra. El ritmo se ajusta solo (autoPace).
let lastD = null; let lastSpoke = 0; let autoT = null; let autoRound = 0;
function startAuto() {
  if (autoT) clearTimeout(autoT); autoT = null; if (!voice.on) return;
  const tick = () => {
    autoT = null; if (!voice.on) return;
    if (document.visibilityState === 'visible' && lastD && document.body.contains($('#bz_v') || $('#ag_v') || document.body)) { const ph = statusPhrases(lastD); if (ph.length) { voice.say(ph[autoRound % ph.length], false); lastSpoke = Date.now(); autoRound++; if (autoRound % 6 === 0) autoPace.liked(); } }
    autoT = setTimeout(tick, autoPace.get() * 1000 / 3);
  };
  autoT = setTimeout(tick, 8000);
}
function narrate(d) {
  lastD = d;
  if (!d.octopus || !d.ot || d.ot <= thoughtSeen) return; thoughtSeen = d.ot;
  for (const x of d.thoughts || []) setTimeout(() => voice.say(x.text, x.k !== 'hold'), x.k === 'buy' || x.k === 'sell' ? 5000 : 0); // compra/venta: la dice el OVNI cuando llega a la isla; esto es el respaldo
}
// Actualiza SIN recrear: el pulpo sigue nadando y las islas se reacomodan según lo que el bot decide.
function updateViz(bn) {
  const r = $('#bz_v'); if (!r) return; const d = botViz(bn); lastBn = bn; lastD = d;
  if (vizCtl && r.dataset.on === '1' && vizMode === ((d.octopus || d.ufo) ? '3d' : '2d')) { vizCtl.update(d); vizFill(r, d); narrate(d); return; }
  const c = $('canvas', r); if (c) c.replaceWith(c.cloneNode(false)); r.dataset.on = ''; vizFill(r, d); mountViz(bn);
}

// ---- Controles de riesgo visibles, estado de los agentes y evidencia con confianza ----
const confCls = (c) => (c >= 70 ? 'hi' : c >= 50 ? 'mid' : 'lo');
function riskBarHtml(bn, d) {
  const live = bn.mode === 'live'; const L = bn.limits || {}; const sp = L.spent24 || 0; const mx = L.maxDailyUsd || 0; const pctD = mx ? Math.min(100, Math.round((sp / mx) * 100)) : 0;
  const sc = (n) => ((d.scouts || []).find((s) => s.name === n) || {}).val || '…';
  const last = bn.recent && bn.recent[0] ? `${bn.recent[0].side === 'buy' ? 'compra' : 'venta'} ${String(bn.recent[0].symbol).replace('-USD', '')} ${money(bn.recent[0].usd)}` : 'sin órdenes aún';
  return `<div class="rkbar ${live ? 'live' : 'paper'}"><div class="rkhead"><span class="rkmode">${live ? '● DINERO REAL' : '● PAPEL · simulado, sin dinero'}</span><span class="rkst ${bn.enabled ? 'on' : ''}">${bn.enabled ? 'Cerebro activo' : 'Cerebro apagado'}</span></div>
    <div class="rkgrid"><div><small>Por compra</small><b>${money(L.usd, 0)}</b></div><div><small>Tope por orden</small><b>${money(L.maxOrderUsd, 0)}</b></div><div><small>Stop bajo costo</small><b>${L.stopLossPct ? `${L.stopLossPct} %` : '—'}</b></div><div><small>Tope diario${live ? '' : ' (real)'}</small><b>${money(sp, 0)} / ${money(mx, 0)}</b><i class="rkmeter"><u style="width:${pctD}%"></u></i></div></div>
    <div class="rkag"><span>🧭 Mercado: <b>${esc(sc('MERCADO'))}</b></span><span>📰 Noticias: <b>${esc(sc('NOTICIAS'))}</b></span><span>🛡 Riesgo: <b>${esc(sc('RIESGO'))}</b></span><span>⚡ Ejecución: <b>${esc(last)}</b></span></div>
    <div class="rkfoot"><span class="muted">Nada se opera sin tus topes. El modo real solo opera con tu confirmación.</span><span class="row"><button type="button" class="btn small" id="rk_trade">Comprar / Vender</button><button type="button" class="btn danger small" id="rk_kill">⏻ Cerrar todo y apagar</button></span></div></div>`;
}
function evidenceHtml(d) {
  const rows = (d.rows || []).filter((r) => r.conf !== undefined || (r.ev && r.ev.length)).slice(0, 4);
  if (!rows.length) return '<p class="muted" style="margin:0">Todavía ninguna cripto cumple todas las reglas. Cuando una cumpla, aquí verás su confianza y los datos que la respaldan.</p>';
  return rows.map((r) => `<div class="evr"><div class="evh"><b>${esc(r.sym)}</b><span class="evs">${esc(r.state)}</span><span class="evc ${confCls(r.conf || 0)}">Confianza ${r.conf ?? '—'}%</span></div><i class="evbar"><u class="${confCls(r.conf || 0)}" style="width:${r.conf || 0}%"></u></i>${r.why ? `<div class="evw">${esc(r.why)}</div>` : ''}<ul class="evl">${(r.ev || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('') + '<p class="muted" style="font-size:11px;margin:6px 0 0">La confianza es un puntaje (0–100) de qué tan por encima del costo real está la ventaja esperada; no es una probabilidad de ganar.</p>';
}
function refreshRisk(bn) {
  const d = botViz(bn); const r = $('#rk_b'); if (r) { r.innerHTML = riskBarHtml(bn, d); bindKill(); }
  const e = $('#evd_b'); if (e) e.innerHTML = evidenceHtml(d);
}
// Doble toque: el primer toque arma el botón (5 s); el segundo ejecuta. Devuelve true solo en el segundo toque.
function confirmTap(btn, armedText) {
  if (btn.dataset.armed) { clearTimeout(Number(btn.dataset.armed)); delete btn.dataset.armed; return true; }
  const orig = btn.textContent; btn.textContent = armedText; btn.classList.add('armed');
  btn.dataset.armed = String(setTimeout(() => { delete btn.dataset.armed; btn.textContent = orig; btn.classList.remove('armed'); }, 5000));
  return false;
}
function closeSummary(r) {
  const list = r.closed || []; if (!list.length) return 'Bot apagado. No había posiciones abiertas.';
  const ok = list.filter((x) => x.placed); const bad = list.filter((x) => !x.placed);
  return `Bot apagado. ${ok.length} venta(s) enviada(s)${ok.some((x) => x.mode === 'live') ? ' (las reales quedan PENDIENTES hasta que tu exchange las confirme)' : ''}.${bad.length ? ` NO se pudo cerrar: ${bad.map((x) => `${x.symbol}${x.exchange ? '/' + x.exchange : ''} (${x.reason || 'sin motivo'})`).join('; ')}. Revisa tu exchange.` : ''} Las órdenes que ya estuvieran abiertas en el exchange no se cancelan: revísalas allí.`;
}
function showCloseResult(r, node) {
  const msg = closeSummary(r);
  if (node) setMsg(node, msg, !(r.failed > 0)); else alert(msg);
}
async function bindPicks(main) {
  const el = $('#pk_list', main); if (!el) return;
  try {
    const sc = await api('GET', '/api/scanner'); const top = (sc.items || []).filter((i) => i.qualified).slice(0, 5);
    el.className = '';
    el.innerHTML = top.length ? top.map((i) => `<div class="agrow"><div class="agmain"><b>${esc(i.symbol)}</b> <span class="chip">${esc(i.label || '')}</span>
      <div class="muted" style="font-size:12px">Prueba: Coinbase ${pc(i.coinbase.ret)} · Robinhood ${pc(i.robinhood.ret)} (${esc(String(i.test_days))} días) · más barato: ${esc(cheapTxt[i.cheaper] || i.cheaper)}</div></div>
      <button class="btn small" data-pk="${esc(i.symbol)}">Elegir</button></div>`).join('') : '<p class="muted">Ninguna cripto pasa la prueba ahora mismo: es mejor no comprar. El Cerebro vuelve a revisar cada hora.</p>';
    el.querySelectorAll('[data-pk]').forEach((b) => { b.onclick = () => { const f = $('#mt_f', main); if (f) { f.symbol.value = b.dataset.pk; f.scrollIntoView({ behavior: 'smooth' }); setMsg($('#mt_m', main), `Elegiste ${b.dataset.pk}. Revisa modo y monto, y toca Comprar dos veces.`, true); } }; });
  } catch (e) { el.textContent = e.message; }
}

function bindManual(main, { connections, live }) {
  const box = $('#mt_box', main); if (!box) return;
  const msg = $('#mt_m', main); const posEl = $('#mt_pos', main);
  const loadPos = async () => {
    try { const p = await api('GET', '/api/positions'); const row = (x, m) => `<tr><td>${esc(x.symbol)}</td><td>${m}</td><td class="r">${num(x.qty, 8)}</td><td class="r">${money(x.avgCost)}</td></tr>`;
      posEl.innerHTML = p.live.length || p.paper.length ? `<div class="scroll"><table><thead><tr><th>Cripto</th><th>Modo</th><th class="r">Cantidad</th><th class="r">Costo medio</th></tr></thead><tbody>${p.live.map((x) => row(x, 'REAL · ' + esc(x.exchange))).join('')}${p.paper.map((x) => row(x, 'papel')).join('')}</tbody></table></div>` : '<p class="muted" style="font-size:13px">Sin posiciones abiertas.</p>'; } catch { /* sin lista */ }
  };
  loadPos();
  const trade = async (side, frac) => {
    const f = $('#mt_f', main); const mode = f.mode.value; const body = { side, mode, symbol: f.symbol.value.trim().toUpperCase(), confirm: true };
    if (side === 'buy') { body.usd = Number(f.usd.value); body.liveAck = f.ack.checked; body.connectionId = f.connectionId ? f.connectionId.value : null; } else body.fraction = frac;
    try { const r = await api('POST', '/api/trade', body); const x = (r.results || [])[0];
      setMsg(msg, x ? (x.placed ? `${side === 'buy' ? 'Compra' : 'Venta'} enviada${mode === 'live' ? ' (pendiente hasta que el exchange la confirme)' : ' (simulada)'}.` : `No se envió: ${x.reason || 'sin motivo'}`) : 'No tienes posición para vender en ese modo.', !!(x && x.placed)); loadPos(); }
    catch (e) { setMsg(msg, e.message); }
  };
  const btn = (id, side, frac, txt) => { const b = $(id, main); b.onclick = () => { if (confirmTap(b, `Toca otra vez: ${txt}`)) trade(side, frac); }; };
  btn('#mt_buy', 'buy', 1, 'COMPRAR'); btn('#mt_s25', 'sell', 0.25, 'VENDER 25%'); btn('#mt_s50', 'sell', 0.5, 'VENDER 50%'); btn('#mt_s100', 'sell', 1, 'VENDER 100%');
}

function bindKill() {
  const tr = $('#rk_trade'); if (tr && !tr.dataset.b) { tr.dataset.b = '1'; tr.onclick = () => { state.tab = 'bot'; shell(); loadTab().then(() => { const m = $('#mt_box'); if (m) m.scrollIntoView({ behavior: 'smooth' }); }); }; }
  const k = $('#rk_kill'); if (!k || k.dataset.b) return; k.dataset.b = '1';
  k.onclick = async () => {
    if (!confirmTap(k, 'Toca otra vez: VENDER todo y apagar')) return;
    k.disabled = true;
    try { const r = await api('POST', '/api/bot/kill', { closeAll: true }); showCloseResult(r); const b = await api('GET', '/api/bot/status'); const el = $('#botnow_b'); if (el) { el.innerHTML = botNowHtml(b); bindBotNow(); } updateViz(b); refreshRisk(b); k.disabled = false; k.textContent = '⏻ Cerrar todo y apagar'; }
    catch (e) { k.disabled = false; alert(e.message); }
  };
}

const myBotCards = (bn) => `<div class="card" data-open id="rk"><h2>Controles de riesgo</h2><div id="rk_b">${riskBarHtml(bn, botViz(bn))}</div></div>\n  <div class="card" data-open id="bz"><h2>Cerebro en vivo</h2><div id="bz_b">${vizHtml(botViz(bn), 'bz_v')}</div></div>
  <div class="card" data-open id="evd"><h2>Por qué y con qué confianza</h2><div id="evd_b">${evidenceHtml(botViz(bn))}</div></div>\n  <div class="card" data-open id="pf"><h2>Ganado desde que se encendió el bot</h2><div id="pf_c" class="muted">Calculando…</div></div>
  <div class="card" data-open id="dash"><h2>Tablero · dinero real primero</h2><div id="dash_b" class="muted">Cargando…</div></div>
  <div class="card" id="res"><h2>Resultados por periodo</h2><div id="res_b" class="muted">Calculando…</div></div>
  <div class="card" id="ver"><h2>Verificación con tu exchange</h2><div id="ver_b"><p class="muted" style="margin:0 0 8px">Compara lo que el bot anotó con lo que reporta tu exchange: saldos y órdenes.</p><button class="btn small" id="ver_go" type="button">Verificar ahora</button></div></div>
  <div class="card" data-open id="botnow"><h2>Mi bot ahora</h2><div id="botnow_b">${botNowHtml(bn)}</div></div>
  <div class="card" id="pc"><h2>Gráfico de precio</h2><div id="pc_c">${priceCardHtml(bn)}</div></div>
  <div class="card"><h2>Mis exchanges en vivo <button class="btn ghost small" id="live_r" type="button" style="margin-left:8px">↻</button></h2><div id="live_b" class="muted">Leyendo tu exchange…</div></div>`;
function startMyBot(bn) {
  bindBotNow(); bindKill(); refreshLive(); refreshDash(); loadProfit(bn.mode); loadResults(); bindVerify(); bindPrice(); mountViz(bn);
  const lr = $('#live_r'); if (lr) lr.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); refreshLive(true); });
  let n = 0; let waiting = bn.enabled && !bn.last; let on = bn.enabled;
  tabTimer = setInterval(async () => {
    n++; if (n % 8 === 0) { refreshLive(); refreshDash(); loadProfit(bn.mode); loadResults(); }
    if (!(waiting || (on && n % 2 === 0) || n % 8 === 0)) return; // con el bot encendido, el pulpo se actualiza cada ~8 s
    try { const b = await api('GET', '/api/bot/status'); const el = $('#botnow_b'); if (el) { if (!el.contains(document.activeElement)) { el.innerHTML = botNowHtml(b); bindBotNow(); } updateViz(b); refreshRisk(b); } waiting = b.enabled && !b.last; on = b.enabled; } catch { /* reintenta en el próximo ciclo */ }
  }, 4000);
}

function onboardHtml(bn, conns) {
  const connected = conns.connections.length > 0; const tried = bn.enabled || (bn.recent || []).length > 0; const live = bn.enabled && bn.mode === 'live';
  if (connected && tried && live) return '';
  const st = [[tried, 'Prueba el bot en papel', 'Sin dinero real, con precios reales. Toca «Encender Cerebro (papel)» abajo.', 'bot'], [connected, 'Conecta tu exchange', 'Robinhood o Coinbase, con llave de solo ver y operar (nunca retiros).', 'exchanges'], [live, 'Activa dinero real con topes', 'Cuando estés cómodo: desde el Tablero, con tu propio monto.', null]];
  const done = st.filter((x) => x[0]).length;
  return `<div class="card" data-open><div class="row" style="justify-content:space-between"><h2 style="margin:0">Primeros pasos</h2><span class="chip ${done === 3 ? 'paper' : ''}">${done}/3</span></div><div class="meter"><i style="width:${(done / 3) * 100}%"></i></div>
    ${st.map((x) => `<div class="step-row ${x[0] ? 'ok' : ''}"><span class="dot">${x[0] ? '✓' : '○'}</span><div class="grow"><b>${esc(x[1])}</b><div class="muted" style="font-size:12px">${esc(x[2])}</div></div>${!x[0] && x[3] ? `<button class="btn ghost small" data-go="${x[3]}">Ir ›</button>` : ''}</div>`).join('')}</div>`;
}
async function tabResumen(main) {
  const [pnl, bot, conns, bn] = await Promise.all([api('GET', '/api/pnl'), api('GET', '/api/bot'), api('GET', '/api/connections'), api('GET', '/api/bot/status')]);
  const rows = pnl.positions.map((p) => `<tr><td><span class="chip ${esc(p.mode)}">${p.mode === 'live' ? 'REAL' : 'PAPEL'}</span></td><td>${esc(p.symbol)}</td>
    <td class="r">${num(p.qty, 8)}</td><td class="r">${money(p.cost)}</td><td class="r">${money(p.value)}</td>
    <td class="r ${cls(p.unrealized)}">${money(p.unrealized)}</td><td class="r ${cls(p.realized)}">${money(p.realized)}</td></tr>`).join('');
  main.innerHTML = `
  ${onboardHtml(bn, conns)}
  ${myBotCards(bn)}
  <div class="banner">El modo <b>papel</b> simula con precios reales y <b>no mueve dinero</b>. Lo simulado no garantiza resultados reales.</div>
  <div class="kpis">
    <div class="kpi"><div class="l">Bot</div><div class="v">${bot.cfg.enabled ? 'Activo' : 'Apagado'}</div><div class="s">${bot.cfg.symbol === 'AUTO' ? 'Cerebro AUTO' : esc(bot.cfg.strategy.toUpperCase()) + ' · ' + esc(bot.cfg.symbol)} · ${bot.cfg.mode === 'live' ? 'REAL' : 'papel'}</div></div>
    <div class="kpi"><div class="l">Exchanges conectados</div><div class="v">${conns.connections.length}</div><div class="s">solo llaves de trading</div></div>
    <div class="kpi"><div class="l">Posiciones</div><div class="v">${pnl.positions.length}</div><div class="s">según tus órdenes</div></div>
  </div>
  <div class="card"><h2>Resultado por posición</h2>
    ${rows ? `<div class="scroll"><table><thead><tr><th>Modo</th><th>Par</th><th class="r">Cantidad</th><th class="r">Costo</th><th class="r">Valor</th><th class="r">No realizado</th><th class="r">Realizado</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">Aún no hay órdenes. Configura tu bot en la pestaña Bot (empieza en modo papel).</p>'}
  </div>`;
  startMyBot(bn);
  document.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => { state.tab = x.dataset.go; shell(); loadTab(); }));
}

const EXCH = {
  coinbase: { name: 'Coinbase', url: 'https://portal.cdp.coinbase.com/access/api',
    steps: ['Abre Coinbase Developer Platform e inicia sesión.', 'Crea una API key nueva (Secret API key).', 'Permisos: marca solo <b>View</b> y <b>Trade</b>. <b>NO</b> marques Transfer/retiros.', 'Copia el <b>API key name</b> (empieza con <code>organizations/</code>) y la <b>Private key</b> completa.'],
    idLabel: 'API key name', idHint: 'organizations/…/apiKeys/…', secLabel: 'Private key (bloque completo)', secHint: '-----BEGIN EC PRIVATE KEY-----…' },
  robinhood: { name: 'Robinhood', url: 'https://robinhood.com/account/crypto',
    steps: ['Pulsa <b>Generar mis llaves</b> (abajo): se crean en tu teléfono y la privada no sale de él.', 'Copia la <b>llave pública</b>.', 'En Robinhood (web): Cuenta → Configuración → Cripto → <b>API Trading</b> → crear credenciales. Pega ahí la <b>llave pública</b> y deja permisos de ver y operar.', 'Robinhood te da una <b>API key</b>. Pégala en el paso ②; la llave privada ya se llena sola.', 'Esta API no permite retiros.'],
    idLabel: 'API key que te dio Robinhood', idHint: 'rh-api-…', secLabel: 'Llave privada (se llena sola al generarla)', secHint: 'base64, una línea' },
};

async function tabExchanges(main) {
  const { connections } = await api('GET', '/api/connections');
  const rows = connections.map((c) => `<div class="step-row ok"><span class="dot">✓</span><div class="grow"><b>${esc(EXCH[c.exchange] ? EXCH[c.exchange].name : c.exchange)}</b> <span class="muted">${esc(c.label)}</span>
    <div class="row" style="margin-top:4px"><span class="chip paper">🔒 cifrada</span><span class="chip">${c.can_transfer ? 'retiros ON' : 'solo trading'}</span></div></div>
    <button class="btn ghost small" data-test="${esc(c.id)}">Probar</button><button class="btn ghost small" data-bal="${esc(c.id)}">Saldos</button><button class="btn danger small" data-del="${esc(c.id)}">Quitar</button></div>`).join('');
  main.innerHTML = `
  <div class="card" data-open><h2>Mis conexiones (${connections.length})</h2>${rows || '<p class="muted">Aún no conectas ningún exchange. Es opcional: puedes usar el modo papel sin conectar nada.</p>'}<div id="bal" class="msg"></div></div>
  <div class="card" data-open><h2>Conectar un exchange</h2>
    <div class="row" id="ex_pick"><button class="btn small" data-ex="coinbase">Coinbase</button><button class="btn ghost small" data-ex="robinhood">Robinhood</button></div>
    <div id="ex_wiz"></div>
  </div>
  <details class="card acc"><summary><h2>¿Es seguro? Cómo protegemos tu llave</h2></summary><div class="accb"><ul class="lessons">
    <li>Solo aceptamos llaves de <b>trading sin retiros</b>; si permite retirar, la rechazamos.</li>
    <li>Tu llave se <b>cifra (AES-256)</b> antes de guardarse. Nadie la ve, ni el dueño.</li>
    <li>Cada cuenta es aislada: ningún cliente puede ver datos de otro.</li>
    <li>Puedes quitarla cuando quieras y se borra al instante.</li></ul></div></details>`;
  let cur = 'coinbase';
  const wiz = () => {
    const e = EXCH[cur];
    document.querySelectorAll('#ex_pick button').forEach((b) => b.classList.toggle('ghost', b.dataset.ex !== cur));
    $('#ex_wiz').innerHTML = `
    <details class="stepbox" open><summary>① Crea la llave en ${esc(e.name)}</summary><ol class="steps">${e.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
      ${cur === 'robinhood' ? `<div class="gen"><button class="btn small" id="gen_btn" type="button">🔑 Generar mis llaves</button><div id="gen_out"></div></div>` : ''}
      <a class="btn ghost small" href="${esc(e.url)}" target="_blank" rel="noopener">Abrir ${esc(e.name)} ›</a>
      <p class="muted" style="font-size:12px">Si el enlace cambió, busca "API" en tu cuenta de ${esc(e.name)}.</p></details>
    <details class="stepbox" open><summary>② Pégala aquí</summary>
    <form id="cf" class="form">
      <label class="full">${esc(e.idLabel)}<input name="keyId" required autocomplete="off" placeholder="${esc(e.idHint)}"></label>
      <label class="full">${esc(e.secLabel)}<textarea name="secret" required autocomplete="off" spellcheck="false" placeholder="${esc(e.secHint)}"></textarea></label>
      <label class="full">Nombre (opcional)<input name="label" maxlength="60" placeholder="Mi cuenta"></label>
      <button class="btn full" type="submit">Verificar y conectar</button><div id="cm" class="full"></div>
    </form></details>`;
    const gb = $('#gen_btn');
    if (gb) gb.addEventListener('click', async () => {
      try {
        const k = await genEd25519();
        $('#cf [name=secret]').value = k.privateKey;
        $('#gen_out').innerHTML = `<p class="muted" style="font-size:12px;margin:8px 0 4px">Tu <b>llave pública</b> (cópiala y pégala en Robinhood):</p><code id="gen_pub" style="display:block;user-select:all">${esc(k.publicKey)}</code>
          <div class="row" style="margin-top:6px"><button class="btn ghost small" id="gen_copy" type="button">Copiar llave pública</button><span class="msg ok" id="gen_m"></span></div>
          <p class="muted" style="font-size:12px;margin:6px 0 0">La llave privada ya quedó en el paso ②. No la compartas con nadie.</p>`;
        $('#gen_copy').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(k.publicKey); $('#gen_m').textContent = 'Copiada'; }
          catch { const r = document.createRange(); r.selectNodeContents($('#gen_pub')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); $('#gen_m').textContent = 'Selecciónala y cópiala'; }
        });
      } catch (err) { $('#gen_out').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    $('#cf').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      $('#cm').innerHTML = '<div class="msg ok">Verificando con el exchange…</div>';
      try {
        const r = await api('POST', '/api/connections', { ...f, exchange: cur });
        $('#cm').innerHTML = `<div class="checks">${r.checks.map((c) => `<div class="${c.ok ? 'pos' : 'neg'}">${c.ok ? '✓' : '✗'} ${esc(c.label)}</div>`).join('')}<div class="pos">✓ Guardada cifrada</div></div>`;
        setTimeout(loadTab, 1200);
      } catch (err) {
        const d = err.data || {};
        $('#cm').innerHTML = `<div class="checks">${(d.checks || []).map((c) => `<div class="${c.ok ? 'pos' : 'neg'}">${c.ok ? '✓' : '✗'} ${esc(c.label)}</div>`).join('')}<div class="neg"><b>${esc(err.message)}</b></div>${d.hint ? `<div class="muted">${esc(d.hint)}</div>` : ''}</div>`;
      }
    });
  };
  document.querySelectorAll('#ex_pick button').forEach((b) => b.addEventListener('click', () => { cur = b.dataset.ex; wiz(); }));
  wiz();
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '¿Seguro?'; return; }
    try { await api('DELETE', `/api/connections/${b.dataset.del}`); await loadTab(); } catch (err) { setMsg($('#bal'), err.message); }
  }));
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    setMsg($('#bal'), 'Probando (solo lectura, sin órdenes)…', true);
    try {
      const r = await api('POST', `/api/connections/${b.dataset.test}/test`, {});
      $('#bal').className = 'msg';
      $('#bal').innerHTML = `<div class="checks">${r.steps.map((x) => `<div class="${x.ok ? 'pos' : 'neg'}">${x.ok ? '✓' : '✗'} ${esc(x.label)}${x.detail ? ` — ${esc(x.detail)}` : ''}${x.hint ? `<div class="muted">${esc(x.hint)}</div>` : ''}</div>`).join('')}<div class="${r.ok ? 'pos' : 'neg'}"><b>${r.ok ? 'Conexión lista' : 'Hay algo que arreglar'}</b></div><div class="muted">${esc(r.note || '')}</div></div>`;
    } catch (err) { setMsg($('#bal'), err.message); }
  }));
  document.querySelectorAll('[data-bal]').forEach((b) => b.addEventListener('click', async () => {
    setMsg($('#bal'), 'Consultando…', true);
    try {
      const r = await api('GET', `/api/connections/${b.dataset.bal}/balances`);
      $('#bal').className = 'msg ok';
      $('#bal').textContent = r.balances.length ? r.balances.map((x) => `${x.asset}: ${num(x.available, 8)}`).join('  ·  ') : 'Sin saldo.';
    } catch (err) { setMsg($('#bal'), err.message); }
  }));
}

async function tabBot(main) {
  const [{ cfg }, { connections }] = await Promise.all([api('GET', '/api/bot'), api('GET', '/api/connections')]);
  try { state.uni = (await api('GET', '/api/universe')).symbols; } catch { state.uni = null; }
  const live = state.me.liveTradingEnabled;
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label || v)}</option>`;
  main.innerHTML = `
  <div class="card" data-open><h2>Empezar en 1 toque</h2>
    <p class="muted" style="font-size:13px;margin:0 0 8px">El <b>Cerebro AUTO</b> prueba todas las criptos grandes con costos reales de Coinbase y Robinhood y solo compra las que pasan la prueba, en el exchange más barato. Empieza en papel (sin dinero).</p>
    <div class="row"><button class="btn" id="q_auto">▶ Cerebro AUTO · papel</button><button class="btn ghost" id="q_demo">Demo: BTC cada 15 min</button></div><div class="msg" id="qm"></div>
  </div>
  <div class="card" data-open id="pk_box"><h2>Mejores compras ahora</h2>
    <p class="muted" style="font-size:13px;margin:0 0 8px">Las criptos que hoy pasan la prueba del Cerebro (historial con costos reales de Coinbase y Robinhood), de mejor a peor. <b>Es una selección por historial, no una promesa de ganancia</b>: el precio puede bajar.</p>
    <div id="pk_list" class="muted">Cargando…</div>
  </div>
  <div class="card" data-open id="mt_box"><h2>Comprar / Vender a mano</h2>
    <p class="muted" style="font-size:13px;margin:0 0 8px">Cada botón pide un segundo toque para confirmar. En <b>real</b>, comprar respeta tus topes, tu plan y la parada de emergencia; <b>vender</b> siempre se permite (solo reduce riesgo). Las órdenes reales quedan pendientes hasta que el exchange las confirme.</p>
    <form id="mt_f" class="form">
      <label>Modo<select name="mode"><option value="paper">Papel (simulado)</option>${live && connections.length ? '<option value="live">REAL</option>' : ''}</select></label>
      <label>Cripto<input name="symbol" list="symlist" value="BTC-USD" autocomplete="off" autocapitalize="characters"></label>
      ${live && connections.length ? `<label>Exchange (real)<select name="connectionId">${connections.map((c) => `<option value="${esc(c.id)}">${esc(c.exchange)} · ${esc(c.label)}</option>`).join('')}</select></label>` : ''}
      <label>USD por compra<input name="usd" type="number" min="1" step="any" value="10"></label>
      <label class="check full"><input type="checkbox" name="ack"><span>Si elegí REAL: entiendo que es dinero real y que puedo perder lo que invierta.</span></label>
      <div class="full row"><button class="btn" type="button" id="mt_buy">Comprar</button><button class="btn danger" type="button" id="mt_s25">Vender 25%</button><button class="btn danger" type="button" id="mt_s50">Vender 50%</button><button class="btn danger" type="button" id="mt_s100">Vender 100%</button></div>
      <div class="msg full" id="mt_m"></div>
    </form>
    <h3 style="margin-top:12px">Mis posiciones abiertas</h3><div id="mt_pos" class="muted">Cargando…</div>
  </div>
  <div class="card" data-open><h2>Real: comprar ya</h2>
    ${live && connections.length ? `<p class="muted" style="font-size:13px;margin:0 0 8px">Compra con dinero REAL en tu exchange, una orden pequeña cada cierto tiempo (DCA), empezando de inmediato. Empieza con montos mínimos.</p>
    <form id="rf" class="form">
      <label>Exchange<select name="connectionId">${connections.map((c) => `<option value="${esc(c.id)}" ${c.exchange === 'robinhood' ? 'selected' : ''}>${esc(c.exchange)} · ${esc(c.label)}</option>`).join('')}</select></label>
      <label>Cripto<input name="symbol" list="symlist" value="${cfg.symbol && cfg.symbol !== 'AUTO' ? esc(cfg.symbol) : 'BTC-USD'}" autocomplete="off" autocapitalize="characters"></label>
      <label>USD por compra<input name="usd" type="number" min="1" step="any" value="5"></label>
      <label>Cada (minutos)<input name="intervalMin" type="number" min="15" value="60"></label>
      <label class="check full"><input type="checkbox" name="ack"><span>Entiendo que es dinero REAL, que puedo perder todo lo que invierta y que Quantum Trading no es asesor financiero.</span></label>
      <div class="full row"><button class="btn" type="submit">▶ Comprar ya (real)</button></div><div class="msg full" id="rm"></div>
    </form>` : `<p class="muted" style="font-size:13px;margin:0">${connections.length ? 'El trading real está apagado. Dueño: Más → Ajustes → Trading REAL → «Solo yo».' : 'Primero conecta tu exchange en <b>Conectar</b>.'}</p>`}
  </div>
  <div class="card"><h2>Avanzado: elegir yo la cripto y la estrategia</h2>
    <form id="bf" class="form">
      <label>Cripto (todas las listadas en Coinbase / Robinhood)<input name="symbol" list="symlist" value="${esc(cfg.symbol)}" autocomplete="off" autocapitalize="characters" spellcheck="false"><datalist id="symlist"><option value="AUTO">AUTO · el Cerebro elige</option>${(state.uni || state.me.symbols.map((s) => ({ s, cb: true, rh: null }))).map((x) => `<option value="${esc(x.s)}">${esc(x.s)}${x.cb ? ' · Coinbase' : ''}${x.rh ? ' · Robinhood' : ''}</option>`).join('')}</datalist><span class="muted" id="symhint" style="font-size:12px"></span></label>
      <label>Exchange (papel) / ruteo<select name="paperExchange">${opt('best', cfg.paperExchange, 'Mejor: el más barato por brecha de costo')}${opt('coinbase', cfg.paperExchange, 'Coinbase')}${opt('robinhood', cfg.paperExchange, 'Robinhood')}</select></label>
      <label class="auto">Modo del Cerebro<select name="autoMode">${opt('pro', cfg.autoMode, 'Pro: varias operaciones cuando conviene (day trader)')}${opt('active', cfg.autoMode, 'Activo: tendencia + acumulación gradual')}${opt('validated', cfg.autoMode, 'Solo estrategias validadas (muy selectivo)')}</select></label>
      <label class="auto">Máx. criptos a la vez<input name="maxPositions" type="number" min="1" max="10" value="${esc(cfg.maxPositions ?? 3)}"></label>
      <label class="noauto">Estrategia<select name="strategy">${opt('dca', cfg.strategy, 'DCA: compra periódica')}${opt('sma', cfg.strategy, 'SMA: cruce de medias (1 h)')}${opt('rsi', cfg.strategy, 'RSI: sobreventa / sobrecompra (1 h)')}${opt('macd', cfg.strategy, 'MACD: cruce de momentum (1 h)')}</select></label>
      <label>Monto por compra (USD)<input name="usd" type="number" min="1" step="any" value="${esc(cfg.usd)}"></label>
      <label class="dca">Cada (minutos)<input name="intervalMin" type="number" min="15" value="${esc(cfg.intervalMin)}"></label>
      <label class="sma">SMA rápida<input name="fast" type="number" min="2" value="${esc(cfg.fast)}"></label>
      <label class="sma">SMA lenta<input name="slow" type="number" min="3" value="${esc(cfg.slow)}"></label>
      <label class="rsi">RSI compra bajo<input name="rsiBuy" type="number" min="5" max="50" value="${esc(cfg.rsiBuy ?? 30)}"></label>
      <label class="rsi">RSI venta sobre<input name="rsiSell" type="number" min="50" max="95" value="${esc(cfg.rsiSell ?? 60)}"></label>
      <label class="nodca">Meta de ganancia % (0 = sin meta; en AUTO es neta de costos)<input name="takeProfitPct" type="number" min="0" max="100" step="any" value="${esc(cfg.takeProfitPct ?? 0)}"></label>
      <label class="nodca">Stop-loss % (0 = sin stop)<input name="stopLossPct" type="number" min="0" max="50" step="any" value="${esc(cfg.stopLossPct ?? 8)}"></label>
      <label>Modo<select name="mode">${opt('paper', cfg.mode, 'Papel (simulado, sin dinero)')}${opt('live', cfg.mode, live ? 'REAL (dinero real)' : 'REAL (no habilitado todavía)')}</select></label>
      <label class="real">Conexión para operar<select name="connectionId"><option value="">— elegir —</option>${connections.map((c) => opt(c.id, cfg.connectionId, `${c.exchange} · ${c.label}`)).join('')}</select></label>
      <label class="real">Tope por orden (USD, máx. ${money(state.me.limits.hardMaxOrder, 0)})<input name="maxOrderUsd" type="number" min="1" step="any" value="${esc(cfg.maxOrderUsd)}"></label>
      <label class="real">Tope diario de compras (USD, máx. ${money(state.me.limits.hardMaxDaily, 0)})<input name="maxDailyUsd" type="number" min="1" step="any" value="${esc(cfg.maxDailyUsd)}"></label>
      <label class="check full real"><input type="checkbox" name="sizing" ${cfg.sizing === 'balance' ? 'checked' : ''}><span>Usar el saldo disponible en mi exchange (se reparte entre posiciones y nunca pasa los topes de abajo)</span></label>
      <label class="check full real"><input type="checkbox" name="liveAck" ${cfg.liveAck ? 'checked' : ''}><span>Entiendo que el modo REAL usa mi dinero, que puedo perder todo lo que invierta, que los resultados pasados o simulados no garantizan resultados futuros y que Quantum Trading no es asesor financiero.</span></label>
      <label class="check full"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}><span><b>Bot encendido</b></span></label>
      <div class="full row"><button class="btn" type="submit">Guardar</button><button class="btn ghost" type="button" id="pz">Pausar</button><button class="btn danger" type="button" id="kill">⏻ Cerrar todo y apagar</button></div>
      <p class="muted full" id="bstate" style="font-size:12px;margin:0"></p>
      <div class="msg full" id="bm"></div>
    </form>
    ${live ? '' : '<p class="muted" style="font-size:13px">El trading real está desactivado por la plataforma por ahora. Puedes probar todo en modo papel.</p>'}
    <p class="muted" style="font-size:12px">El bot hospedado revisa cada minuto mientras el servidor esté activo. Para mayor control puedes usar el bot descargable en tu propia computadora.</p>
  </div>
  <div class="card"><h2>Análisis técnico (informativo)</h2>
    <div class="row"><button class="btn ghost" id="sg_run" type="button">Ver señales de ${esc(cfg.symbol)}</button></div>
    <div id="sg_out"></div><div class="msg" id="sg_m"></div>
  </div>
  <div class="card"><h2>Probar con historial (backtest)</h2>
    <p class="muted" style="font-size:13px">Simula tu configuración sobre las últimas ~300 velas de 1 hora (unos 12 días) con comisión por nivel de volumen, spread, impacto de mercado y latencia del exchange elegido, y la compara con comprar y mantener. Sirve para descartar estrategias malas; <b>no predice el futuro</b>.</p>
    <div class="form" style="margin-bottom:10px">
      <label>Simular en<select id="bt_ex"><option value="coinbase">Coinbase Advanced</option><option value="robinhood">Robinhood Crypto</option></select></label>
      <label>Capital virtual<select id="bt_cap"><option value="1000">$1,000</option><option value="10000">$10,000</option><option value="100000">$100,000</option><option value="1000000">$1,000,000</option></select></label>
    </div>
    <div class="row"><button class="btn ghost" id="bt_run" type="button">Correr backtest</button></div>
    <div id="bt_out" class="scroll"></div><div class="msg" id="bt_m"></div>
  </div>`;
  const rf = $('#rf');
  if (rf) rf.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!rf.ack.checked) return setMsg($('#rm'), 'Marca la confirmación de riesgo para continuar.');
    const usd = Number(rf.usd.value);
    try {
      await quickStart({ symbol: rf.symbol.value.trim().toUpperCase(), strategy: 'dca', usd, intervalMin: Number(rf.intervalMin.value), mode: 'live', connectionId: rf.connectionId.value,
        maxOrderUsd: usd, maxDailyUsd: Math.min(state.me.limits.hardMaxDaily, usd * 24), paperExchange: 'coinbase', liveAck: true, enabled: true });
    } catch (err) { setMsg($('#rm'), err.message); }
  });
  $('#q_auto').addEventListener('click', () => quickStart(AUTO_PRESET).catch((e) => setMsg($('#qm'), e.message)));
  $('#q_demo').addEventListener('click', () => quickStart(DEMO_PRESET).catch((e) => setMsg($('#qm'), e.message)));
  const hint = () => {
    const v = $('#bf').symbol.value.trim().toUpperCase(); const u = (state.uni || []).find((x) => x.s === v);
    $('#symhint').textContent = v === 'AUTO' ? 'El Cerebro elige qué comprar y dónde.' : u ? `${u.cb ? 'Coinbase ✓' : 'Coinbase ✗'} · ${u.rh === null ? 'Robinhood: conecta para verificar' : u.rh ? 'Robinhood ✓' : 'Robinhood ✗'}` : v ? 'No aparece en la lista' : '';
  };
  const sync = () => {
    const f = $('#bf'); const au = f.symbol.value.trim().toUpperCase() === 'AUTO'; hint();
    document.querySelectorAll('.noauto').forEach((n) => { n.style.display = au ? 'none' : ''; });
    document.querySelectorAll('.auto').forEach((n) => { n.style.display = au ? '' : 'none'; });
    document.querySelectorAll('.dca').forEach((n) => { n.style.display = !au && f.strategy.value === 'dca' ? '' : 'none'; });
    document.querySelectorAll('.sma').forEach((n) => { n.style.display = !au && f.strategy.value === 'sma' ? '' : 'none'; });
    document.querySelectorAll('.rsi').forEach((n) => { n.style.display = !au && f.strategy.value === 'rsi' ? '' : 'none'; });
    document.querySelectorAll('.nodca').forEach((n) => { n.style.display = au || f.strategy.value === 'dca' ? 'none' : ''; });
    document.querySelectorAll('.real').forEach((n) => { n.style.display = f.mode.value === 'live' ? '' : 'none'; });
  };
  $('#bf').addEventListener('change', sync); $('#bf').symbol.addEventListener('input', sync); sync();
  $('#bf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { symbol: f.symbol.value.trim().toUpperCase(), autoMode: f.autoMode.value, paperExchange: f.paperExchange.value, maxPositions: f.maxPositions.value, strategy: f.strategy.value, usd: f.usd.value, intervalMin: f.intervalMin.value, fast: f.fast.value,
      slow: f.slow.value, rsiBuy: f.rsiBuy.value, rsiSell: f.rsiSell.value, stopLossPct: f.stopLossPct.value, takeProfitPct: f.takeProfitPct.value, mode: f.mode.value, connectionId: f.connectionId.value || null, maxOrderUsd: f.maxOrderUsd.value,
      maxDailyUsd: f.maxDailyUsd.value, liveAck: f.liveAck.checked, sizing: f.sizing.checked ? 'balance' : 'fixed', enabled: f.enabled.checked };
    try { await api('PUT', '/api/bot', body); setMsg($('#bm'), 'Guardado.', true); } catch (err) { setMsg($('#bm'), err.message); }
  });
  $('#sg_run').addEventListener('click', async () => {
    const sym = $('#bf').symbol.value.trim().toUpperCase();
    if (sym === 'AUTO') return setMsg($('#sg_m'), 'En AUTO mira el ranking del Cerebro en la pestaña Mercado.');
    setMsg($('#sg_m'), 'Consultando…', true);
    try {
      const r = await api('GET', `/api/signals?symbol=${encodeURIComponent(sym)}`);
      const m = r.model;
      setMsg($('#sg_m'), '');
      $('#sg_out').innerHTML = `<div class="scroll"><table><tbody>
        <tr><td>Precio</td><td class="r">${money(r.price)}</td></tr>
        <tr><td>RSI (14)</td><td class="r">${r.rsi === null ? '—' : r.rsi.toFixed(1)}</td></tr>
        <tr><td>MACD</td><td class="r">${r.macd ? esc(r.macd.state) : '—'}</td></tr>
        <tr><td>Bollinger %B</td><td class="r">${r.bollinger ? r.bollinger.pctB.toFixed(2) : '—'}</td></tr>
        <tr><td>Tendencia SMA20/50</td><td class="r">${r.trend ? esc(r.trend) : '—'}</td></tr>
        <tr><td>Modelo ML (activado por el dueño)</td><td class="r">${m ? `prob. de subida ${(m.prob_up * 100).toFixed(1)} %` : 'sin modelo con ventaja demostrada'}</td></tr></tbody></table></div>
        ${m ? `<p class="muted" style="font-size:12px">Precisión fuera de muestra ${(m.test_accuracy * 100).toFixed(1)} % vs. línea base ${(m.baseline * 100).toFixed(1)} %. Factores: ${m.why.map((w) => esc(w.name)).join(', ')}.</p>` : ''}
        <p class="muted" style="font-size:12px">${esc(r.disclaimer)}</p>`;
    } catch (err) { setMsg($('#sg_m'), err.message); }
  });
  $('#bt_run').addEventListener('click', async () => {
    const f = $('#bf');
    setMsg($('#bt_m'), 'Calculando…', true);
    try {
      const r = await api('POST', '/api/backtest', { symbol: f.symbol.value.trim().toUpperCase(), paperExchange: 'coinbase', strategy: f.strategy.value, usd: f.usd.value,
        intervalMin: f.intervalMin.value, fast: f.fast.value, slow: f.slow.value, rsiBuy: f.rsiBuy.value, rsiSell: f.rsiSell.value, stopLossPct: f.stopLossPct.value, maxOrderUsd: f.maxOrderUsd.value, maxDailyUsd: f.maxDailyUsd.value,
        exchange: $('#bt_ex').value, capital: $('#bt_cap').value });
      const m = r.metrics;
      const pct = (x) => (x === null ? '—' : `${x.toFixed(2)} %`);
      const n2 = (x) => (x === null ? '—' : x.toFixed(2));
      setMsg($('#bt_m'), '');
      $('#bt_out').innerHTML = `<table><tbody>
        <tr><td>Retorno de la estrategia</td><td class="r ${cls(m.totalReturnPct)}">${pct(m.totalReturnPct)}</td></tr>
        <tr><td>Comprar y mantener</td><td class="r ${cls(m.buyHoldPct)}">${pct(m.buyHoldPct)}</td></tr>
        <tr><td>Caída máxima (max drawdown)</td><td class="r neg">${pct(m.maxDrawdownPct)}</td></tr>
        <tr><td>Sharpe / Sortino (anualizados)</td><td class="r">${n2(m.sharpe)} / ${n2(m.sortino)}</td></tr>
        <tr><td>Comisiones pagadas</td><td class="r neg">${money(r.costs.feesUsd)}</td></tr>
        <tr><td>Spread + impacto de mercado</td><td class="r neg">${money(r.costs.slippageUsd)}</td></tr>
        <tr><td>Costo total / % del capital</td><td class="r neg">${money(r.costs.totalUsd)} / ${pct(r.costs.dragPct)}</td></tr>
        <tr><td>Compras / operaciones cerradas</td><td class="r">${m.buys} / ${m.closedTrades}</td></tr>
        <tr><td>Beta / alfa anual vs. el activo</td><td class="r">${n2(m.beta)} / ${pct(m.alphaAnnualPct)}</td></tr>
        <tr><td>Tiempo en posición</td><td class="r">${pct(m.exposurePct)}</td></tr>
        <tr><td>% ganadoras / factor de beneficio</td><td class="r">${pct(m.winRatePct)} / ${n2(m.profitFactor)}</td></tr></tbody></table>
        <p class="muted" style="font-size:12px">Capital virtual ${money(r.capital, 0)} (sin dinero real), ${r.candles} velas. Costos: ${esc(r.cost_profile)}. Son estimaciones; verifica tarifas y spreads reales en tu exchange.</p>`;
    } catch (err) { setMsg($('#bt_m'), err.message); }
  });
  bindManual(main, { connections, live }); bindPicks(main);
  $('#kill').addEventListener('click', async () => {
    if (!confirmTap($('#kill'), 'Toca otra vez: VENDER todo y apagar')) return;
    try { const r = await api('POST', '/api/bot/kill', { closeAll: true }); $('#bf').enabled.checked = false; showCloseResult(r, $('#bm')); showBotState(); $('#kill').textContent = '⏻ Cerrar todo y apagar'; } catch (err) { setMsg($('#bm'), err.message); }
  });
  // Estado real del ciclo de vida (lo guarda el servidor) y pausa/reanudar.
  const STATE_ES = { CREATED: 'creado', CONFIGURED: 'configurado', VALIDATING: 'validando', RUNNING: 'en marcha', PAUSED: 'en pausa', STOPPING: 'deteniéndose', STOPPED: 'detenido', ERROR: 'con error', EMERGENCY_STOP: 'PARADA DE EMERGENCIA' };
  async function showBotState() {
    try {
      const b = await api('GET', '/api/bot/status'); const l = b.lifecycle || {}; const el = $('#bstate'); if (!el) return;
      el.textContent = `Estado: ${STATE_ES[l.state] || l.state}${l.reason ? ` · ${l.reason}` : ''}${l.heartbeat_age_s != null && b.enabled ? ` · último latido hace ${l.heartbeat_age_s} s` : ''}${l.status === 'stale' ? ' · SIN LATIDO RECIENTE' : ''}`;
      const pz = $('#pz'); if (pz) { pz.textContent = l.state === 'PAUSED' ? 'Reanudar' : 'Pausar'; pz.disabled = !(b.enabled && ['RUNNING', 'PAUSED'].includes(l.state)); }
    } catch { /* informativo */ }
  }
  $('#pz').addEventListener('click', async () => {
    try { const b = await api('GET', '/api/bot/status'); await api('POST', b.lifecycle && b.lifecycle.state === 'PAUSED' ? '/api/bot/resume' : '/api/bot/pause'); await showBotState(); } catch (err) { setMsg($('#bm'), err.message); }
  });
  showBotState();
}

async function tabOrdenes(main) {
  const { orders } = await api('GET', '/api/orders?limit=200');
  const rows = orders.map((o) => `<tr><td>${esc(when(o.created_at))}</td><td><span class="chip ${esc(o.mode)}">${o.mode === 'live' ? 'REAL' : 'PAPEL'}</span></td><td>${esc(o.symbol)}</td>
    <td>${o.side === 'buy' ? 'Compra' : 'Venta'}</td><td class="r">${money(o.usd)}</td><td class="r">${num(o.qty, 8)}</td><td class="r">${money(o.price)}</td>
    <td>${o.status === 'ok' ? '<span class="pos">ok</span>' : `<span class="neg">${esc(o.status)}</span>`}</td><td>${esc(o.note)}</td></tr>`).join('');
  main.innerHTML = `<div class="card"><h2>Tus órdenes</h2>${rows ? `<div class="scroll"><table><thead><tr><th>Fecha</th><th>Modo</th><th>Par</th><th>Lado</th><th class="r">USD</th><th class="r">Cantidad</th><th class="r">Precio</th><th>Estado</th><th>Nota</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Sin órdenes todavía.</p>'}</div>`;
}

async function tabDescargar(main) {
  main.innerHTML = `
  <div class="card"><h2>Bot descargable</h2>
    <p>Un solo archivo que corre en <b>tu computadora</b> con <b>tus llaves</b>. Tus llaves nunca salen de tu equipo ni pasan por nuestro servidor.</p>
    <p><a class="btn" href="/api/bot/download" download>Descargar quantum-bot.mjs</a></p>
    <ol class="steps">
      <li>Instala Node.js 20 o superior (nodejs.org).</li>
      <li>Crea un archivo <code>.env</code> junto al bot con: <code>EXCHANGE=coinbase</code>, <code>KEY_ID=...</code>, <code>SECRET_FILE=ruta-a-tu-llave.pem</code>, <code>SYMBOL=BTC-USD</code>, <code>STRATEGY=dca</code>, <code>USD=10</code>.</li>
      <li>Prueba en papel: <code>node quantum-bot.mjs</code> (simulado, sin dinero).</li>
      <li>Dinero real, solo cuando estés listo: <code>I_ACCEPT_RISK=yes node quantum-bot.mjs --live</code>.</li>
      <li>Ayuda: <code>node quantum-bot.mjs --help</code>.</li>
    </ol>
    <p class="muted" style="font-size:13px">Usa siempre llaves de solo trading (sin retiros). El bot se niega a operar en real si la llave permite retiros.</p>
  </div>`;
}


async function tabCuenta(main) {
  main.innerHTML = `
  <div class="card"><h2>Cambiar contraseña</h2>
    ${state.user.role === 'owner' ? '<p class="muted">La contraseña del dueño se define en OWNER_PASSWORD (variables de entorno de Render).</p>' : `
    <form id="pf" class="form">
      <label>Contraseña actual<input name="current" type="password" required autocomplete="current-password"></label>
      <label>Nueva (mín. 10 caracteres)<input name="next" type="password" required minlength="10" autocomplete="new-password"></label>
      <button class="btn full" type="submit">Cambiar</button><div class="msg full" id="pm"></div>
    </form>`}
  </div>
  ${state.user.role === 'owner' ? '' : '<div class="card" id="plancard"><h2>Mi plan</h2><div id="planb" class="muted">Cargando…</div></div>'}
  <div class="card" id="seccard"><h2>Seguridad de la cuenta</h2><div id="secb" class="muted">Cargando…</div></div>
  <div class="card"><h2>Mis datos</h2>
    <p class="muted" style="font-size:13px">Descarga una copia de tu perfil, configuración y órdenes. Tus llaves API no se incluyen.</p>
    <a class="btn ghost" href="/api/me/export" download>Descargar mis datos (JSON)</a>
  </div>
  ${state.user.role === 'owner' ? '' : `<div class="card"><h2>Eliminar mi cuenta</h2>
    <p class="muted" style="font-size:13px">Borra tu cuenta, tus llaves cifradas, tu bot y tus órdenes. No se puede deshacer.</p>
    <form id="df" class="form"><label>Tu contraseña<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn danger full" type="submit">Eliminar cuenta definitivamente</button><div class="msg full" id="dm"></div></form></div>`}`;
  loadSecurityCard(); loadPlanCard();
  const pf = $('#pf');
  if (pf) pf.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/me/password', { current: pf.current.value, next: pf.next.value }); state.user = null; render(); }
    catch (err) { setMsg($('#pm'), err.message); }
  });
  const df = $('#df');
  if (df) df.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!df.dataset.sure) { df.dataset.sure = '1'; setMsg($('#dm'), 'Pulsa otra vez para confirmar la eliminación.'); return; }
    try { await api('DELETE', '/api/me', { password: df.password.value }); state.user = null; render(); }
    catch (err) { setMsg($('#dm'), err.message); }
  });
}

const STATUS_ES = { trialing: 'en prueba', active: 'activo', past_due: 'pago vencido', ended: 'terminado', expired: 'prueba terminada' };
async function loadPlanCard() {
  const box = $('#planb'); if (!box) return;
  let b; try { b = await api('GET', '/api/billing'); } catch (e) { box.textContent = e.message; return; }
  const c = b.current; box.className = '';
  // Modo gratis: sin límites de plan activados y sin cobro configurado → todo es gratis y no se muestran precios.
  if (!b.enforced && !b.checkout_available) { box.innerHTML = '<p><b class="pos">Todo gratis por ahora</b></p><p class="muted" style="font-size:13px">Todas las funciones están abiertas sin costo y sin tarjeta. Tus topes de riesgo siguen siendo los que tú definas.</p>'; return; }
  const date = (t) => (t ? new Date(t).toLocaleDateString() : '—');
  box.innerHTML = `
    <p><b>${esc((b.plans.find((p) => p.id === c.plan) || {}).label || c.plan)}</b> · ${esc(STATUS_ES[c.status] || c.status)}${c.period_end ? ` · hasta ${esc(date(c.period_end))}` : ''}${c.cancel_at_period_end ? ' · no se renovará' : ''}</p>
    ${c.reason ? `<p class="muted" style="font-size:13px">${esc(c.reason)}</p>` : ''}
    ${b.enforced ? '' : '<p class="muted" style="font-size:12px">Los límites de plan aún no están activados en esta plataforma.</p>'}
    <div class="aglist">${b.plans.map((p) => `<div class="agrow"><div class="agmain"><b>${esc(p.label)}</b> ${p.priceUsdMonth ? `<span class="chip">$${p.priceUsdMonth}/mes${p.priceIsProposal ? ' (propuesta)' : ''}</span>` : ''}
      <div class="muted" style="font-size:12px">${esc(p.blurb)}${p.live ? ` Hasta $${p.maxOrderUsd}/orden y $${p.maxDailyUsd}/día.` : ''}</div></div>
      ${p.id !== 'free_trial' && p.id !== c.plan ? `<button class="btn ghost sm" data-plan="${esc(p.id)}">Elegir</button>` : ''}</div>`).join('')}</div>
    ${c.plan !== 'free_trial' && c.plan !== 'owner' ? '<button class="btn ghost" id="portal">Administrar pago y factura</button>' : ''}
    <div class="msg" id="plm"></div>
    <p class="muted" style="font-size:12px">${esc(b.note)}</p>`;
  const go = async (path, body) => { try { const r = await api('POST', path, body); location.href = r.url; } catch (e) { setMsg($('#plm'), e.message); } };
  box.querySelectorAll('[data-plan]').forEach((x) => { x.onclick = () => go('/api/billing/checkout', { plan: x.dataset.plan }); });
  const pt = $('#portal'); if (pt) pt.onclick = () => go('/api/billing/portal');
}

async function loadBillingCard() {
  const box = $('#billb'); if (!box) return;
  let b; try { b = await api('GET', '/api/owner/billing'); } catch (e) { box.textContent = e.message; return; }
  box.innerHTML = `
    <p class="muted" style="font-size:13px">Cobro en línea: <b>${b.stripe_configured ? 'configurado' : 'NO configurado'}</b> · Correo: <b>${b.mail === 'none' ? 'NO configurado' : esc(b.mail)}</b> · Pagos activos: <b>${b.paid_active}</b> · Pagos vencidos: <b class="${b.past_due ? 'neg' : ''}">${b.past_due}</b> · Webhooks fallidos: <b class="${b.failed_webhooks ? 'neg' : ''}">${b.failed_webhooks}</b></p>
    <p class="muted" style="font-size:12px">Clientes por plan: ${Object.entries(b.by_plan).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || 'ninguno'}</p>
    <label class="check"><input type="checkbox" id="b_enf" ${b.enforce ? 'checked' : ''}><span><b>Hacer cumplir los límites de plan</b>: sin plan vigente no hay trading real. Actívalo solo cuando el cobro y los correos funcionen y hayas probado el flujo.</span></label>
    <div class="row" style="margin-top:10px"><button class="btn" id="b_save">Guardar</button></div><div class="msg" id="b_m"></div>
    <table class="tbl"><thead><tr><th>Evento</th><th>Estado</th><th>Detalle</th></tr></thead><tbody>${b.webhooks.slice(0, 10).map((h) => `<tr><td>${esc(h.type)}</td><td class="${h.status === 'failed' ? 'neg' : ''}">${esc(h.status)}${h.attempts > 1 ? ` ×${h.attempts}` : ''}</td><td>${esc(h.detail || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin eventos todavía.</td></tr>'}</tbody></table>`;
  $('#b_save').onclick = async () => { try { await api('PUT', '/api/owner/billing', { enforce: $('#b_enf').checked }); setMsg($('#b_m'), 'Guardado.', true); } catch (e) { setMsg($('#b_m'), e.message); } };
}

async function loadSecurityCard() {
  const box = $('#secb'); if (!box) return;
  const u = state.user; let ss = [];
  try { ss = (await api('GET', '/api/me/sessions')).sessions; } catch { /* se muestra sin lista */ }
  const dev = (x) => `<div class="agrow"><div class="agmain"><b>${x.current ? 'Este dispositivo' : 'Otro dispositivo'}</b><div class="muted" style="font-size:12px">${esc(String(x.ua || 'navegador').slice(0, 80))} · ${esc(x.ip || '—')} · activo ${esc(ago(x.last_seen))}</div></div>${x.current ? '' : `<button class="btn ghost sm" data-rv="${esc(x.id)}">Cerrar</button>`}</div>`;
  box.className = '';
  box.innerHTML = `
    <p><b>Correo:</b> ${esc(u.email)} — ${u.email_verified ? '<span class="pos">verificado</span>' : '<span class="neg">sin verificar</span> (hace falta para operar en real)'}</p>
    ${u.email_verified ? '' : '<button class="btn ghost" id="vsend">Enviarme el correo de verificación</button><div class="msg" id="vm"></div>'}
    ${u.role === 'owner' ? '' : `<h3 style="margin-top:14px">Verificación en dos pasos (2FA)</h3>
      <p class="muted" style="font-size:13px">${u.totp ? 'Activa. Al entrar se pide un código de tu app (Google Authenticator, etc.).' : 'Opcional pero recomendada: protege tu cuenta aunque alguien conozca tu contraseña.'}</p>
      <form id="mf" class="form">
        <label class="full">Tu contraseña<input name="password" type="password" required autocomplete="current-password"></label>
        ${u.totp ? '<label class="full">Código actual de 6 dígitos<input name="code" inputmode="numeric" maxlength="6" required></label><button class="btn danger full" type="submit">Desactivar 2FA</button>' : '<button class="btn full" type="submit">Activar 2FA</button>'}
        <div class="msg full" id="mm"></div>
      </form><div id="mfx"></div>`}
    <h3 style="margin-top:14px">Dispositivos con sesión abierta</h3>
    <div class="aglist">${ss.length ? ss.map(dev).join('') : '<p class="muted">Sin datos.</p>'}</div>
    ${ss.length > 1 ? '<button class="btn ghost" id="rvo">Cerrar todas las demás sesiones</button>' : ''}`;
  const vs = $('#vsend'); if (vs) vs.onclick = async () => { try { const r = await api('POST', '/api/auth/verify-email/send'); setMsg($('#vm'), r.warning || 'Te enviamos el correo. Revisa tu bandeja y spam.', !r.warning); } catch (e) { setMsg($('#vm'), e.message); } };
  box.querySelectorAll('[data-rv]').forEach((b) => { b.onclick = async () => { try { await api('POST', '/api/me/sessions/revoke', { id: b.dataset.rv }); loadSecurityCard(); } catch (e) { alert(e.message); } }; });
  const ro = $('#rvo'); if (ro) ro.onclick = async () => { try { await api('POST', '/api/me/sessions/revoke-others'); loadSecurityCard(); } catch (e) { alert(e.message); } };
  const mf = $('#mf'); if (!mf) return;
  mf.addEventListener('submit', async (e) => {
    e.preventDefault(); const mm = $('#mm');
    try {
      if (u.totp) { await api('POST', '/api/me/2fa/disable', { password: mf.password.value, code: mf.code.value }); state.user = (await api('GET', '/api/me')).user; loadSecurityCard(); return; }
      const s = await api('POST', '/api/me/2fa/setup', { password: mf.password.value });
      $('#mfx').innerHTML = `<p>1) En tu app de autenticación elige «Ingresar clave de configuración» y pega: <code style="user-select:all">${esc(s.secret)}</code></p>
        <form id="mf2" class="form"><label class="full">2) Escribe el código de 6 dígitos<input name="code" inputmode="numeric" maxlength="6" required></label><button class="btn full" type="submit">Confirmar y activar</button><div class="msg full" id="mm2"></div></form>`;
      $('#mf2').addEventListener('submit', async (e2) => {
        e2.preventDefault();
        try { const r = await api('POST', '/api/me/2fa/enable', { code: e2.target.code.value }); state.user = (await api('GET', '/api/me')).user;
          $('#mfx').innerHTML = `<div class="card"><b>Guarda estos códigos de respaldo ahora</b><p class="muted" style="font-size:13px">Cada uno sirve una sola vez si pierdes tu teléfono. No se vuelven a mostrar.</p><pre style="user-select:all">${r.recovery_codes.map(esc).join('\n')}</pre></div>`; }
        catch (er) { setMsg($('#mm2'), er.message); }
      });
    } catch (er) { setMsg(mm, er.message); }
  });
}

const KIND_LABEL = { strategy_defaults: 'Estrategia sugerida', agent_toggle: 'Agente', model_update: 'Modelo ML',
  risk_alert: 'Riesgo', ops_alert: 'Operación', insight: 'Hallazgo' };
const APPLIES = ['strategy_defaults', 'agent_toggle', 'model_update'];
const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };
const pc = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)} %`);

function spark(vals, w = 160, h = 40) {
  if (!vals || vals.length < 2) return '<span class="muted" style="font-size:12px">sin datos aún</span>';
  const lo = Math.min(...vals); const hi = Math.max(...vals); const r = hi - lo || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((v - lo) / r) * (h - 6)).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="curva de capital"><polyline points="${pts}" class="${up ? 'up' : 'dn'}"/></svg>`;
}

async function tabLaunch(main) {
  const r = await api('GET', '/api/owner/readiness');
  const goBtn = (g) => (!g ? '' : g.url ? `<a class="btn ghost small" href="${esc(g.url)}" target="_blank" rel="noopener">Abrir ›</a>` : `<button class="btn ghost small" data-go="${esc(g.tab)}">Ir ›</button>`);
  const rows = r.items.map((i) => `<details class="step ${i.status}"><summary class="step-row ${i.status}">
    <span class="dot">${i.status === 'ok' ? '✓' : '○'}</span>
    <div class="grow"><b>${esc(i.label)}</b></div><span class="muted">${i.status === 'todo' ? '▾' : ''}</span></summary>
    <div class="stepb"><p class="muted" style="margin:0 0 8px">${esc(i.step)}</p>
      ${i.help ? `<ol class="steps">${i.help.map((h) => `<li>${esc(h)}</li>`).join('')}</ol>` : ''}
      <div class="row" style="margin-top:10px">${goBtn(i.go)}${i.manual ? `<button class="btn ${i.status === 'ok' ? 'ghost' : ''} small" data-step="${esc(i.id)}" data-done="${i.status === 'ok' ? '0' : '1'}">${i.status === 'ok' ? 'Desmarcar' : 'Marcar como hecho'}</button>` : ''}</div></div></details>`).join('');
  const todo = r.items.filter((i) => i.status === 'todo').length;
  main.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Listo para vender</h2><span class="chip ${r.score >= 80 ? 'paper' : ''}">${r.score} %</span></div>
    <div class="meter"><i style="width:${r.score}%"></i></div>
    <p class="muted" style="margin:8px 0 0;font-size:13px">${todo ? `Te faltan ${todo} paso${todo === 1 ? '' : 's'}.` : 'Todo marcado. Puedes lanzar.'} Trading real: <b>${r.live_trading ? 'ACTIVADO' : 'apagado'}</b> · Registro: <b>${r.registration_open ? 'abierto' : 'cerrado'}</b></p>
  </div>
  <div class="card">${rows}<div class="msg" id="lm"></div></div>`;
  document.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => { state.tab = x.dataset.go; if (!state.tab.startsWith('o_') && state.user.role === 'owner') state.showClient = true; shell(); loadTab(); }));
  document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('PUT', '/api/owner/readiness', { id: b.dataset.step, done: b.dataset.done === '1' }); await loadTab(); } catch (err) { setMsg($('#lm'), err.message); }
  }));
}

async function tabCerebro(main) {
  const b = await api('GET', '/api/owner/brain');
  const lab = b.lab; const lastRun = (name) => { for (const r of b.runs) { const a = r.agents.find((x) => x.agent === name); if (a) return { t: r.t, ...a }; } return null; };
  const active = b.agents.filter((a) => a.enabled).length; const avail = b.agents.filter((a) => a.available).length;
  const labCards = ['BTC-USD', 'ETH-USD'].map((sym) => {
    const ch = lab.champions[sym]; const l = lab.latest[sym];
    if (!ch) return `<div class="c2"><h3>${esc(sym)}</h3><p class="muted">${(() => { const lr = lastRun('paper_lab'); return lr && lr.notes && lr.notes.length ? esc(lr.notes.join(' · ')) : 'Corre los agentes para elegir campeón.'; })()}</p></div>`;
    const row = (name, x) => x ? `<tr><td>${name}</td><td class="r ${cls(x.ret)}">${pc(x.ret, 2)}</td><td class="r ${cls(x.bh)}">${pc(x.bh, 2)}</td><td class="r">${x.drag.toFixed(3)} %</td><td class="r">${x.trades}</td></tr>` : `<tr><td>${name}</td><td colspan="4" class="muted">recopilando…</td></tr>`;
    return `<div class="c2"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(sym)} · ${esc(ch.label)}</h3><span class="chip ${ch.validated ? 'paper' : ''}">${ch.validated ? 'validada' : 'sin validar'}</span></div>
      <div class="row" style="margin:8px 0">${spark(l && l.coinbase ? l.coinbase.equity : null)}<span class="muted" style="font-size:12px">${l ? `${(l.candles / 24).toFixed(1)} d en vivo` : 'día 0'}</span></div>
      <div class="scroll"><table><thead><tr><th></th><th class="r">Retorno</th><th class="r">Comprar y mant.</th><th class="r">Costo</th><th class="r">Ops</th></tr></thead><tbody>${row('Coinbase', l && l.coinbase)}${row('Robinhood', l && l.robinhood)}</tbody></table></div>
      ${(() => { const lg = (l && l.coinbase && l.coinbase.log) || []; return lg.length ? `<details class="stepbox"><summary>Operaciones simuladas (${lg.length})</summary><div class="scroll"><table><thead><tr><th>Cuándo</th><th>Lado</th><th class="r">Precio</th><th class="r">USD</th><th class="r">P&amp;L</th></tr></thead><tbody>${lg.slice().reverse().map((x) => `<tr><td>${esc(ago(x.t))}</td><td>${x.side === 'buy' ? 'Compra' : 'Venta'}</td><td class="r">${money(x.price)}</td><td class="r">${money(x.usd, 0)}</td><td class="r ${cls(x.pnl)}">${x.pnl === null ? '—' : money(x.pnl, 0)}</td></tr>`).join('')}</tbody></table></div></details>` : ''; })()}
      <p class="muted" style="font-size:11px;margin:6px 0 0">Antes de congelar: ${pc(ch.val_return)} vs ${pc(ch.val_bh)} (validación)</p></div>`;
  }).join('');
  const st = Object.fromEntries((b.agent_stats || []).map((x) => [x.name, x]));
  const agents = b.agents.map((a) => { const lr = lastRun(a.name); const x = st[a.name] || {}; return `<div class="agrow"><div class="agt"><b>${esc(a.label)}</b><span>${a.available ? (a.enabled ? '<span class="pos">activo</span>' : 'apagado') : '<span class="muted">próximamente</span>'}</span></div>
    <div class="muted agm">${lr ? `última: ${ago(lr.t)}${lr.error ? ' · <span class="neg">error</span>' : ''}` : 'sin correr'}${a.available ? ` · <span title="corridas · propuestas · aplicadas · rechazadas">${x.runs || 0} corr · ${x.created || 0} prop · <span class="pos">${x.applied || 0}</span> apl · ${x.rejected || 0} rech</span>` : ''}</div>
    ${a.available ? `<button class="btn ghost small" data-ag="${esc(a.name)}" data-en="${a.enabled ? '0' : '1'}">${a.enabled ? 'Apagar' : 'Encender'}</button>` : ''}</div>`; }).join('');
  const pend = b.pending.map((p) => `<div class="prop"><div class="row"><span class="chip">${esc(KIND_LABEL[p.kind] || p.kind)}</span><span class="muted" style="font-size:12px">${esc(p.agent || '')}</span></div>
    <div style="margin:6px 0"><b>${esc(p.title)}</b></div>
    <details><summary class="muted" style="font-size:12px;cursor:pointer">Datos</summary><pre style="white-space:pre-wrap;font-size:11px;overflow-x:auto">${esc(JSON.stringify(p.evidence, null, 1))}</pre></details>
    <div class="row" style="margin-top:8px">${APPLIES.includes(p.kind) ? `<button class="btn small" data-dec="approve" data-id="${esc(p.id)}">Aprobar</button>` : `<button class="btn ghost small" data-dec="approve" data-id="${esc(p.id)}">Enterado</button>`}
    <button class="btn ghost small" data-dec="reject" data-id="${esc(p.id)}">Rechazar</button></div></div>`).join('');
  const runs = b.runs.slice(0, 8).map((r) => { const act = r.agents.filter((a) => a.error || a.created > 0); const quiet = r.agents.length - act.length;
    return `<div class="rnrow"><div class="rnh"><b>${esc(ago(r.t))}</b><span class="muted">${esc(r.trigger)}</span></div><div class="muted runs">${act.length ? act.map((a) => `${esc((b.agents.find((q) => q.name === a.agent) || {}).label || a.agent)}: ${a.error ? '✗ error' : `${a.created} propuesta(s)`}`).join(' · ') : 'sin propuestas nuevas'}${quiet ? ` · ${quiet} sin novedades` : ''}</div></div>`; }).join('');
  const lessons = (lab.lessons || []).slice(0, 5).map((x) => `<li><span class="muted">${esc(ago(x.t))}</span> ${esc(x.text)}</li>`).join('');
  const hist = b.history.map((p) => `<tr><td>${esc(ago(p.decided_at || p.created_at))}</td><td style="white-space:normal">${esc(p.title)}</td><td>${esc(p.status)}</td></tr>`).join('');
  const models = b.models.map((m) => `<tr><td>${esc(m.symbol)}</td><td>${m.active ? '<span class="pos">activo</span>' : '—'}</td><td>${m.candidate ? `${(m.candidate.metrics.acc_test * 100).toFixed(1)} % vs ${(m.candidate.metrics.baseline_test * 100).toFixed(1)} %` : '—'}</td></tr>`).join('');
  const g = b.guardrails;
  main.innerHTML = `
  <div class="card" data-open><h2>Cerebro en vivo</h2>${vizHtml(agentsViz(b), 'ag_v')}</div>
  <div class="kpis">
    <div class="kpi"><div class="l">Cerebro</div><div class="v">v${b.brain_version}</div><div class="s">app ${esc(b.app_version)}</div></div>
    <div class="kpi"><div class="l">Agentes</div><div class="v">${active}/${avail}</div><div class="s">activos</div></div>
    <div class="kpi"><div class="l">Propuestas</div><div class="v">${b.pending.length}</div><div class="s">${b.stats.applied} aplicadas · ${b.stats.rejected} rechazadas</div></div>
    <div class="kpi"><div class="l">Laboratorio</div><div class="v">${lab.runs || 0}</div><div class="s">corridas · ${esc(ago(b.last_run))}</div></div>
  </div>
  <div class="row"><button class="btn" id="br_run">▶ Correr agentes ahora</button><span class="msg" id="br_m"></span></div>
  <div class="card" data-open><h2>Escáner de criptos · ${b.scanner ? `${b.scanner.items.filter((i) => i.qualified).length} validadas de ${b.scanner.scanned}` : 'sin datos'}</h2>${scannerHtml(b.scanner)}</div>
  <div class="card"><h2>Laboratorio de papel · $1M virtual</h2><div class="grid">${labCards}</div>
    ${lessons ? `<h2 style="margin-top:14px">Lo que aprendió</h2><ul class="lessons">${lessons}</ul>` : ''}</div>
  <div class="card" ${b.pending.length ? "data-open" : ""}><h2>Por decidir (${b.pending.length})</h2>${pend || '<p class="muted">Nada pendiente.</p>'}<div class="msg" id="pr_m"></div></div>
  <div class="card"><h2>Agentes</h2><div class="aglist">${agents}</div><div class="msg" id="ag_m"></div></div>
  <div class="card"><h2>Corridas</h2>${runs ? `<div class="aglist">${runs}</div>` : '<p class="muted">Sin corridas.</p>'}</div>
  <details class="card"><summary><h2 style="display:inline">Modelos ML</h2></summary><div class="scroll"><table><thead><tr><th>Par</th><th>Estado</th><th>Precisión vs base</th></tr></thead><tbody>${models}</tbody></table></div></details>
  <details class="card"><summary><h2 style="display:inline">Historial (${b.history.length})</h2></summary>${hist ? `<div class="scroll"><table><tbody>${hist}</tbody></table></div>` : '<p class="muted">Vacío.</p>'}</details>
  <details class="card"><summary><h2 style="display:inline">Límites inviolables</h2></summary>
    <form id="gf" class="form" style="margin-top:10px">
      <label>Máx. pendientes<input name="maxPendingProposals" type="number" min="1" max="100" value="${esc(g.maxPendingProposals)}"></label>
      <label>Auto-corrida (horas)<input name="autoRunHours" type="number" min="1" max="168" value="${esc(g.autoRunHours)}"></label>
      <label class="full">Tipos permitidos<span class="row">${Object.keys(KIND_LABEL).map((k) => `<label class="check"><input type="checkbox" name="kind_${k}" ${g.allowedKinds.includes(k) ? 'checked' : ''}><span>${esc(KIND_LABEL[k])}</span></label>`).join('')}</span></label>
      <p class="muted full" style="font-size:12px">Protegido: ${g.protectedAreas.map((a) => `<code>${esc(a)}</code>`).join(' ')}</p>
      <button class="btn full" type="submit">Guardar</button><div class="msg full" id="gm"></div></form></details>`;
  mountCity($('#ag_v'), agentsViz(b));
  $('#br_run').addEventListener('click', async (e) => {
    e.target.disabled = true; setMsg($('#br_m'), 'Corriendo agentes…', true);
    try { await api('POST', '/api/owner/brain/run'); await loadTab(); } catch (err) { setMsg($('#br_m'), err.message); e.target.disabled = false; }
  });
  document.querySelectorAll('[data-dec]').forEach((x) => x.addEventListener('click', async () => {
    try { await api('POST', `/api/owner/proposals/${x.dataset.id}/decision`, { decision: x.dataset.dec }); await loadTab(); } catch (err) { setMsg($('#pr_m'), err.message); }
  }));
  document.querySelectorAll('[data-ag]').forEach((x) => x.addEventListener('click', async () => {
    try { await api('PUT', `/api/owner/agents/${x.dataset.ag}`, { enabled: x.dataset.en === '1' }); await loadTab(); } catch (err) { setMsg($('#ag_m'), err.message); }
  }));
  $('#gf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const allowedKinds = Object.keys(KIND_LABEL).filter((k) => f[`kind_${k}`].checked);
    try { await api('PUT', '/api/owner/guardrails', { maxPendingProposals: f.maxPendingProposals.value, autoRunHours: f.autoRunHours.value, allowedKinds }); setMsg($('#gm'), 'Guardado.', true); }
    catch (err) { setMsg($('#gm'), err.message); }
  });
}

async function tabExport(main) {
  const b = await api('GET', '/api/owner/brain');
  main.innerHTML = `
  <div class="card"><h2>Descargas del dueño</h2>
    <p>Versión del app <b>${esc(b.app_version)}</b> · Cerebro <b>v${b.brain_version}</b>. Cada cambio aprobado sube la versión del Cerebro.</p>
    <div class="row"><a class="btn" href="/api/owner/export/brain" download>Descargar Cerebro (JSON)</a><a class="btn ghost" href="/api/owner/export/app" download>Descargar app completo (.tar.gz)</a></div>
    <p class="muted" style="font-size:13px">El Cerebro incluye límites, agentes, modelos, propuestas y bitácora. El .tar.gz trae el código y BRAIN.json. Ninguno contiene contraseñas, llaves API ni datos individuales de clientes. Guárdalos como respaldo antes de cambios grandes.</p>
  </div>`;
}


// Todas las tarjetas con título se vuelven secciones que se despliegan al tocar. La primera (o las marcadas data-open) abre sola.
// Botón 🔈 de cada sección: lee en voz alta el título y el contenido visible (sin botones ni formularios), en frases cortas.
let readingBtn = null;
const cardText = (d) => {
  const title = (d.querySelector('summary h2') || {}).textContent || '';
  const clone = (d.querySelector('.accb') || d).cloneNode(true);
  clone.querySelectorAll('button, input, select, textarea, canvas, svg, script, style, .spk, details:not([open]) > :not(summary)').forEach((x) => x.remove());
  return `${title}. ${clone.innerText || clone.textContent || ''}`.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, ' ').replace(/[▲▼•·→↑↓⏻]/g, ' ').replace(/\s+/g, ' ').trim();
};
const speechChunks = (t) => { const out = []; let cur = ''; for (const part of t.split(/(?<=[.!?:;])\s+/)) { if ((cur + ' ' + part).length > 220 && cur) { out.push(cur.trim()); cur = part; } else cur += ' ' + part; } if (cur.trim()) out.push(cur.trim()); return out.flatMap((x) => (x.length > 260 ? x.match(/.{1,240}(\s|$)/g).map((y) => y.trim()) : [x])).filter(Boolean).slice(0, 14); };
function toggleReadCard(d, btn) {
  if (readingBtn === btn) { voice.stop(); btn.textContent = '🔈'; readingBtn = null; return; }
  if (readingBtn) readingBtn.textContent = '🔈';
  const txt = cardText(d); if (!txt) return;
  if (!voice.readAll(speechChunks(txt))) return;
  readingBtn = btn; btn.textContent = '⏹';
  const unsub = voice.subscribe(() => setTimeout(() => { if (readingBtn === btn && !voice.speakingNow) { btn.textContent = '🔈'; readingBtn = null; unsub(); } }, 600));
}

function accordionize(main) {
  let i = 0;
  [...main.children].forEach((c) => {
    if (!c.classList.contains('card') || c.tagName === 'DETAILS') return;
    const h = c.firstElementChild;
    if (!h || h.tagName !== 'H2') return;
    const d = document.createElement('details');
    d.className = 'card acc';
    if (c.hasAttribute('data-open') || i === 0) d.open = true;
    const sm = document.createElement('summary');
    sm.append(h);
    if (voice.supported) { const sp = document.createElement('button'); sp.type = 'button'; sp.className = 'spk'; sp.textContent = '🔈'; sp.title = 'Escuchar esta sección'; sp.setAttribute('aria-label', 'Escuchar esta sección'); sm.append(sp); sp.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleReadCard(d, sp); }); }
    const body = document.createElement('div');
    body.className = 'accb';
    while (c.firstChild) body.append(c.firstChild);
    d.append(sm, body);
    c.replaceWith(d);
    i++;
  });
}

async function tabHoy(main) {
  const [b, br, bn] = await Promise.all([api('GET', '/api/owner/briefing'), api('GET', '/api/owner/brain'), api('GET', '/api/bot/status')]);
  const icon = { crit: '●', warn: '●', info: '○' };
  const imp = b.items.filter((i) => i.level !== 'info'); const rest = b.items.filter((i) => i.level === 'info');
  const li = (i) => `<button class="item ${esc(i.level)}" data-go="${esc(i.tab)}"><span class="lv">${icon[i.level] || '○'}</span><span class="grow">${esc(i.text)}</span><span class="muted">›</span></button>`;
  const ap = br.guardrails.autopilot;
  const recent = br.changes.slice(0, 5).map((c) => `<div class="step-row"><div class="grow"><b>${esc(c.label || c.kind)}</b> ${c.auto ? '<span class="chip paper">auto</span>' : ''}<div class="muted" style="font-size:12px">${esc(ago(c.t))} · ${esc(c.title)}</div></div>${c.undone ? '<span class="muted">deshecho</span>' : `<button class="btn ghost small" data-undo="${esc(c.id)}">Deshacer</button>`}</div>`).join('');
  main.innerHTML = `
  ${myBotCards(bn)}
  <div class="card hero-o ${esc(b.status)}">
    <div class="row" style="justify-content:space-between"><div><div class="muted" style="font-size:12px;letter-spacing:.1em;text-transform:uppercase">Resumen del Director</div><div class="big">${esc(b.headline)}</div></div>
      <div class="row"><span class="chip">Cerebro v${b.brain_version}</span><span class="chip">${b.score} % listo</span></div></div>
    <div class="row" style="margin-top:12px"><button class="btn" id="h_run">▶ Correr todo</button><span class="msg" id="h_m"></span></div>
  </div>
  ${imp.length ? `<div class="card" style="padding:4px 12px">${imp.map(li).join('')}</div>` : '<div class="card"><span class="pos">✓ Nada requiere tu atención.</span> <span class="muted">Los agentes siguen trabajando solos.</span></div>'}
  <details class="card acc"><summary><h2>Todo lo demás (${rest.length})</h2></summary><div class="accb" style="padding-top:0">${rest.map(li).join('') || '<p class="muted">Nada.</p>'}</div></details>
  <details class="card acc" ${ap.enabled ? 'open' : ''}><summary><h2>Piloto automático: ${ap.enabled ? '<span class="pos">ENCENDIDO</span>' : 'apagado'}</h2></summary><div class="accb">
    <p class="muted" style="margin:0 0 10px">Si lo enciendes, el Cerebro aplica solo mejoras de <b>bajo riesgo</b> (estrategia sugerida y modelo de señal) que ya pasaron sus pruebas. <b>Nunca</b> toca riesgo, seguridad, agentes ni accesos, y todo se puede deshacer.</p>
    <label class="check"><input type="checkbox" id="ap_sw" ${ap.enabled ? 'checked' : ''}><span><b>Piloto automático</b></span></label>
    <div class="msg" id="ap_m"></div>
    ${recent ? `<h2 style="margin-top:14px">Cambios recientes</h2>${recent}` : ''}</div></details>
  <details class="card acc" id="nums"><summary><h2>Números del negocio (automáticos)</h2></summary><div class="accb" id="h_nums"><p class="muted">Toca para cargar…</p></div></details>
  <p class="muted" style="font-size:12px">Actualizado ${esc(ago(b.t))} · última corrida ${esc(ago(b.last_run))}</p>`;
  document.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => { state.tab = x.dataset.go; shell(); loadTab(); }));
  startMyBot(bn);
  $('#h_run').addEventListener('click', async (e) => {
    e.target.disabled = true; setMsg($('#h_m'), 'El Director está orquestando a los agentes…', true);
    try { await api('POST', '/api/owner/brain/run'); await loadTab(); } catch (err) { setMsg($('#h_m'), err.message); e.target.disabled = false; }
  });
  $('#ap_sw').addEventListener('change', async (e) => {
    try { await api('PUT', '/api/owner/guardrails', { autopilot: { enabled: e.target.checked } }); setMsg($('#ap_m'), e.target.checked ? 'Piloto encendido.' : 'Piloto apagado.', true); setTimeout(loadTab, 600); } catch (err) { setMsg($('#ap_m'), err.message); e.target.checked = !e.target.checked; }
  });
  document.querySelectorAll('[data-undo]').forEach((x) => x.addEventListener('click', async () => {
    try { await api('POST', '/api/owner/brain/undo', { id: x.dataset.undo }); await loadTab(); } catch (err) { setMsg($('#ap_m'), err.message); }
  }));
  $('#nums').addEventListener('toggle', async () => { if ($('#nums').open && !$('#nums').dataset.l) { $('#nums').dataset.l = '1'; try { await tabOverview($('#h_nums')); } catch (err) { $('#h_nums').textContent = err.message; } } }, { once: false });
}

function scannerHtml(sc) {
  if (!sc || !sc.items || !sc.items.length) return '<p class="muted">El Cerebro aún no escaneó. El Director corre el escáner cada pocas horas; el dueño puede forzarlo en Cerebro.</p>';
  const rows = sc.items.map((i) => `<tr><td><b>${esc(i.symbol.replace('-USD', ''))}</b></td><td>${i.qualified ? '<span class="pos">✔ validada</span>' : '<span class="muted">no pasa</span>'}</td><td>${esc(i.label)}</td>
    <td class="r ${cls(i.coinbase.ret)}">${pc(i.coinbase.ret)}</td><td class="r ${cls(i.robinhood.ret)}">${pc(i.robinhood.ret)}</td><td class="r muted">${pc(i.coinbase.bh)}</td>
    <td class="r">${i.coinbase.drag.toFixed(2)} / ${i.robinhood.drag.toFixed(2)} %</td><td>${esc(cheapTxt[i.cheaper] || '')}</td></tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th>Cripto</th><th></th><th>Estrategia</th><th class="r">Coinbase</th><th class="r">Robinhood</th><th class="r">Mant.</th><th class="r">Costo CB / RH</th><th>Más barato</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="font-size:11px;margin:6px 0 0">${sc.scanned} de ${sc.universe} listadas en Coinbase · ${esc(sc.warning || '')} Actualizado ${esc(ago(sc.t))}.</p>`;
}

async function tabMercado(main) {
  const [m, sc, nw] = await Promise.all([api('GET', '/api/market'), api('GET', '/api/scanner').catch(() => null), api('GET', '/api/news').catch(() => null)]);
  const g = m.global;
  const coins = m.coins.map((c) => `<tr><td><b>${esc(c.symbol.replace('-USD', ''))}</b></td><td class="r">${money(c.price, c.price < 10 ? 4 : 2)}</td><td class="r ${cls(c.ch24)}">${pc(c.ch24)}</td><td class="r ${cls(c.ch7)}">${pc(c.ch7)}</td><td class="r ${cls(c.ch30)}">${pc(c.ch30)}</td></tr>`).join('');
  const books = m.books.map((b) => `<tr><td><b>${esc(b.symbol)}</b></td><td class="r">${b.spreadPct.toFixed(3)} %</td><td class="r">${money(Math.min(b.bidDepthUsd, b.askDepthUsd), 0)}</td><td class="r">${b.volume24Usd ? money(b.volume24Usd, 0) : '—'}</td></tr>`).join('');
  main.innerHTML = `
  <div class="kpis">
    <div class="kpi"><div class="l">Régimen</div><div class="v" style="font-size:20px">${esc(m.regime.label)}</div><div class="s">BTC 7/30 d</div></div>
    <div class="kpi"><div class="l">Dominancia BTC</div><div class="v" style="font-size:20px">${g && g.btcDom !== null ? g.btcDom.toFixed(1) + ' %' : '—'}</div><div class="s">del mercado cripto</div></div>
    <div class="kpi"><div class="l">Mercado 24 h</div><div class="v ${g ? cls(g.mcap24) : ''}" style="font-size:20px">${g ? pc(g.mcap24) : '—'}</div><div class="s">capitalización total</div></div>
  </div>
  ${newsCardHtml(nw)}
  ${futureCardHtml(m.coins)}
  <div class="card" data-open><h2>Precios y tendencia</h2>${coins ? `<div class="scroll"><table><thead><tr><th>Par</th><th class="r">Precio</th><th class="r">24 h</th><th class="r">7 d</th><th class="r">30 d</th></tr></thead><tbody>${coins}</tbody></table></div>` : '<p class="muted">Sin datos de CoinGecko ahora mismo.</p>'}</div>
  <div class="card" data-open><h2>Ranking del Cerebro: todas las criptos grandes</h2>${scannerHtml(sc)}</div>
  <div class="card"><h2>Liquidez real (Coinbase Exchange)</h2>${books ? `<div class="scroll"><table><thead><tr><th>Par</th><th class="r">Spread</th><th class="r">Profundidad ±0.5 %</th><th class="r">Volumen 24 h</th></tr></thead><tbody>${books}</tbody></table></div>` : '<p class="muted">Sin libro de órdenes ahora mismo.</p>'}</div>
  <div class="card"><h2>Tendencia en CoinGecko</h2>${m.trending.length ? `<div class="row">${m.trending.map((t) => `<span class="chip">${esc(t.name)} ${esc(t.symbol.toUpperCase())}</span>`).join('')}</div>` : '<p class="muted">Sin datos.</p>'}</div>
  <p class="muted" style="font-size:12px">${esc(m.note)} Actualizado ${esc(ago(m.t))}.${m.errors.length ? ' Fuentes con problemas: ' + esc(m.errors.join('; ')) : ''}</p>`;
  bindNewsCard(); bindFuture();
}

// ============================ Dueño ============================
function barChart(series, label) {
  const W = 600; const H = 130; const pad = 22;
  const max = Math.max(1, ...series.map((s) => s.n));
  const bw = (W - 10) / series.length;
  const bars = series.map((s, i) => { const h = (s.n / max) * (H - pad - 8); return `<rect class="bar" x="${5 + i * bw + 1}" y="${H - pad - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"><title>${esc(s.date)}: ${s.n}</title></rect>`; }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><line x1="5" y1="${H - pad}" x2="${W - 5}" y2="${H - pad}"/>${bars}
    <text x="5" y="${H - 6}">${esc(series[0].date)}</text><text x="${W - 5}" y="${H - 6}" text-anchor="end">${esc(series[series.length - 1].date)}</text><text x="${W - 5}" y="10" text-anchor="end">máx ${max}</text></svg>`;
}

async function tabOverview(main) {
  const o = await api('GET', '/api/owner/overview');
  const ex = Object.entries(o.connections_by_exchange).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || 'ninguno';
  main.innerHTML = `
  <div class="banner">Datos reales de tu base de datos. Todavía no hay facturación conectada (Stripe): no se muestran ingresos.</div>
  <div class="kpis">
    <div class="kpi"><div class="l">Clientes</div><div class="v">${o.users.total}</div><div class="s">${o.users.active} activos · ${o.users.suspended} suspendidos</div></div>
    <div class="kpi"><div class="l">Nuevos 7 días</div><div class="v">${o.users.new_7d}</div><div class="s">${o.users.active_24h} entraron en 24 h</div></div>
    <div class="kpi"><div class="l">Bots encendidos</div><div class="v">${o.bots.enabled_paper + o.bots.enabled_live}</div><div class="s">${o.bots.enabled_paper} papel · ${o.bots.enabled_live} real</div></div>
    <div class="kpi"><div class="l">Órdenes reales 30 d</div><div class="v">${o.orders.live_count}</div><div class="s">${money(o.orders.live_usd)} volumen</div></div>
    <div class="kpi"><div class="l">Órdenes papel 30 d</div><div class="v">${o.orders.paper_count}</div><div class="s">${money(o.orders.paper_usd)} simulado</div></div>
    <div class="kpi"><div class="l">Errores de órdenes 30 d</div><div class="v">${o.orders.errors}</div><div class="s">${o.security.failed_logins_24h} logins fallidos 24 h</div></div>
  </div>
  <div class="grid">
    <div class="card"><h2>Altas por día (30 d)</h2>${barChart(o.signups_30d, 'Altas por día')}</div>
    <div class="card"><h2>Órdenes por día (30 d)</h2>${barChart(o.orders_30d, 'Órdenes por día')}</div>
  </div>
  <div class="card"><h2>Embudo de clientes</h2>${o.funnel.map((f) => `<div class="fun"><span>${esc(f.k)}</span><div class="bar2"><i style="width:${o.funnel[0].n ? Math.round((f.n / o.funnel[0].n) * 100) : 0}%"></i></div><b>${f.n}</b></div>`).join('')}</div>
  <div class="card"><h2>Conexiones por exchange</h2><p>${ex}</p>
    <h2>Pares más operados</h2><p>${o.top_symbols.length ? o.top_symbols.map(([s, n]) => `${esc(s)}: ${n}`).join(' · ') : 'sin operaciones aún'}</p>
    <p class="muted" style="font-size:12px">Actualizado ${esc(when(o.generated_at))}. Por privacidad, aquí solo ves totales: nunca llaves ni órdenes individuales de clientes.</p></div>`;
}

async function tabClientes(main) {
  const { users } = await api('GET', '/api/owner/users');
  const rows = users.map((u) => `<tr><td>${esc(u.email)}</td><td>${u.status === 'active' ? '<span class="pos">activo</span>' : '<span class="neg">suspendido</span>'}</td>
    <td>${esc(when(u.created_at))}</td><td>${esc(when(u.last_login))}</td><td class="r">${u.connections}</td><td>${esc(u.bot)}</td>
    <td class="r"><button class="btn ${u.status === 'active' ? 'danger' : 'ghost'} small" data-id="${esc(u.id)}" data-to="${u.status === 'active' ? 'suspended' : 'active'}">${u.status === 'active' ? 'Suspender' : 'Reactivar'}</button></td></tr>`).join('');
  main.innerHTML = `<div class="card"><h2>Clientes (${users.length})</h2>${rows ? `<div class="scroll"><table><thead><tr><th>Correo</th><th>Estado</th><th>Alta</th><th>Último acceso</th><th class="r">Exchanges</th><th>Bot</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Aún no hay clientes.</p>'}<div class="msg" id="cm2"></div></div>`;
  document.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('POST', `/api/owner/users/${b.dataset.id}/status`, { status: b.dataset.to }); await loadTab(); } catch (err) { setMsg($('#cm2'), err.message); }
  }));
}


async function tabFinanzas(main) {
  const d = await api('GET', '/api/owner/finance'); const m = d.model; const c = d.calc;
  const costRow = (x, i) => `<div class="row" style="margin:4px 0"><input data-cn="${i}" value="${esc(x.name)}" style="flex:2;min-width:120px" aria-label="Costo"><input data-cu="${i}" type="number" min="0" step="any" value="${x.usd}" style="flex:1;min-width:80px" aria-label="USD por mes"></div>`;
  const k = (l, v, sub, c2) => `<div class="kpi"><div class="l">${l}</div><div class="v ${c2 || ''}" style="font-size:18px">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  main.innerHTML = `<div class="card" data-open><h2>Finanzas del negocio (CFO)</h2>
    <div class="kpis">${k('Costos al mes', money(c.cost))}${k('Ingreso mensual (MRR)', money(c.mrr), 'precio × clientes que pagan')}${k('Ganancia al mes', money(c.profit), c.margin_pct === null ? 'sin ingresos aún' : `margen ${c.margin_pct.toFixed(0)} %`, cls(c.profit))}
      ${k('Clientes para empatar', c.breakeven_customers === null ? '—' : c.breakeven_customers, 'con el precio actual')}${k('Precio mínimo para tu margen', c.price_for_target === null ? '—' : money(c.price_for_target), 'con los clientes actuales')}${k('LTV / CAC', c.ltv_cac === null ? '—' : c.ltv_cac.toFixed(1) + '×', c.ltv ? `LTV ${money(c.ltv, 0)}` : '')}</div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Uso real ahora: ${d.usage.users} clientes activos · ${d.usage.bots_on} bots encendidos (${d.usage.live_bots_on} en real).</p></div>
  <div class="card" data-open><h2>Tus números (los anotas tú)</h2>
    <div class="row"><label style="flex:1;min-width:140px">Precio por cliente (USD/mes)<input id="f_price" type="number" min="0" step="any" value="${m.price}"></label>
      <label style="flex:1;min-width:140px">Clientes que pagan<input id="f_paying" type="number" min="0" value="${m.paying}"></label></div>
    <div class="row"><label style="flex:1;min-width:140px">Costo de conseguir un cliente (CAC, USD)<input id="f_cac" type="number" min="0" step="any" value="${m.cac}"></label>
      <label style="flex:1;min-width:140px">Bajas al mes (%)<input id="f_churn" type="number" min="0" max="100" step="any" value="${m.churn_pct}"></label>
      <label style="flex:1;min-width:140px">Margen objetivo (%)<input id="f_tm" type="number" min="0" max="95" step="any" value="${m.target_margin_pct}"></label></div>
    <h2 style="margin-top:12px">Costos mensuales</h2><div id="f_costs">${m.costs.map(costRow).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="btn ghost small" id="f_add" type="button">+ Costo</button><button class="btn" id="f_save" type="button">Guardar</button></div><div class="msg" id="f_m"></div>
    <p class="muted" style="font-size:12px">Si pones un precio, la página de inicio lo muestra solo (con precio 0 muestra «beta gratis»).</p></div>
  <div class="card"><h2>Consejos del CFO</h2><ul class="lessons">${d.advice.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`;
  let n = m.costs.length;
  $('#f_add').onclick = () => { $('#f_costs').insertAdjacentHTML('beforeend', costRow({ name: '', usd: 0 }, n++)); };
  $('#f_save').onclick = async () => {
    const costs = [...document.querySelectorAll('[data-cn]')].map((el) => ({ name: el.value.trim(), usd: Number(document.querySelector(`[data-cu="${el.dataset.cn}"]`).value) || 0 })).filter((x) => x.name);
    try { await api('PUT', '/api/owner/finance', { price: Number($('#f_price').value), paying: Number($('#f_paying').value), cac: Number($('#f_cac').value), churn_pct: Number($('#f_churn').value), target_margin_pct: Number($('#f_tm').value), costs }); setMsg($('#f_m'), 'Guardado.', true); loadTab(); } catch (e) { setMsg($('#f_m'), e.message); }
  };
}

async function tabSeguridad(main) {
  const [c, { events }, sx] = await Promise.all([api('GET', '/api/owner/compliance'), api('GET', '/api/owner/audit'), api('GET', '/api/owner/security')]);
  const row = (x) => `<div class="step-row ${x.ok ? 'ok' : ''}"><span class="dot">${x.ok ? '✓' : '○'}</span><div class="grow">${esc(x.label)}${x.detail ? `<div class="muted" style="font-size:12px">${esc(x.detail)}</div>` : ''}</div></div>`;
  const rows = events.map((e) => `<tr><td>${esc(ago(e.created_at))}</td><td>${esc(e.action)}</td><td>${esc(e.actor || '—')}</td><td>${esc(e.ip || '')}</td><td>${esc(e.detail || '')}</td></tr>`).join('');
  const secCard = `<div class="card" data-open><div class="row" style="justify-content:space-between"><h2 style="margin:0">Seguridad · últimas 24 h</h2><span class="chip ${sx.flags.length ? 'live' : 'paper'}">${sx.flags.length ? 'revisar' : 'sin alertas'}</span></div>
    <div class="kpis" style="margin-top:8px"><div class="kpi"><div class="l">Accesos fallidos</div><div class="v ${sx.failed_logins ? 'neg' : ''}" style="font-size:18px">${sx.failed_logins}</div><div class="s">${sx.distinct_ips} IP distintas</div></div>
      <div class="kpi"><div class="l">Intentos al panel dueño</div><div class="v ${sx.owner_denied ? 'neg' : ''}" style="font-size:18px">${sx.owner_denied}</div></div>
      <div class="kpi"><div class="l">Cuentas bloqueadas</div><div class="v" style="font-size:18px">${sx.locked_now}</div></div></div>
    ${sx.flags.map((f) => `<div class="msg err" style="margin-top:6px">${esc(f)}</div>`).join('')}
    <div class="muted" style="font-size:12px;margin-top:8px">2FA del dueño: <b class="${sx.checks.twofa ? 'pos' : 'neg'}">${sx.checks.twofa ? 'activo' : 'FALTA'}</b> · HTTPS: ${sx.checks.https ? 'sí' : 'no (local)'} · sesión ${sx.checks.session_hours} h · llaves cifradas · llaves con retiros rechazadas</div>
    ${sx.owner_events.length ? `<div class="scroll" style="margin-top:6px"><table><tbody>${sx.owner_events.map((e) => `<tr><td>${esc(ago(e.t))}</td><td>${esc(e.action)}</td><td>${esc(e.ip || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
  main.innerHTML = secCard + `
  <div class="card" data-open><div class="row" style="justify-content:space-between"><h2 style="margin:0">Cumplimiento (verificado en vivo)</h2><span class="chip ${c.score >= 80 ? 'paper' : ''}">${c.score} %</span></div>
    <div class="meter"><i style="width:${c.score}%"></i></div>
    ${c.live.map(row).join('')}
    <div class="row" style="margin-top:12px"><a class="btn" href="/api/owner/export/compliance" download>⬇ Paquete para abogado</a></div>
    <p class="muted" style="font-size:12px">Un archivo con controles, inventario de datos, proveedores y preguntas listas para tu abogado fintech.</p></div>
  <details class="card acc"><summary><h2>Controles de diseño</h2></summary><div class="accb">${c.design.map(row).join('')}</div></details>
  <details class="card acc"><summary><h2>Datos que guardamos y cómo se protegen</h2></summary><div class="accb scroll"><table><thead><tr><th>Dato</th><th>Para qué</th><th>Cifrado</th><th>Quién lo ve</th></tr></thead><tbody>${c.inventory.map((i) => `<tr><td style="white-space:normal">${esc(i.dato)}</td><td style="white-space:normal">${esc(i.para)}</td><td style="white-space:normal">${esc(i.cifrado)}</td><td style="white-space:normal">${esc(i.ve)}</td></tr>`).join('')}</tbody></table></div></details>
  <details class="card acc"><summary><h2>Brechas conocidas (honesto)</h2></summary><div class="accb"><ul class="lessons">${c.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div></details>
  <details class="card acc"><summary><h2>Preguntas para tu abogado</h2></summary><div class="accb"><ol class="steps">${c.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></div></details>
  <details class="card acc"><summary><h2>Registro de auditoría</h2></summary><div class="accb scroll"><table><thead><tr><th>Cuándo</th><th>Acción</th><th>Usuario</th><th>IP</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

async function loadRiskCard() {
  const box = $('#riskb'); if (!box) return;
  try {
    const r = await api('GET', '/api/owner/risk'); if (!box.isConnected) return; const em = r.emergency; const p = r.platform;
    const sm = box.parentElement && box.parentElement.querySelector('summary h2'); if (sm && em.on) sm.textContent = 'Riesgo y parada de emergencia · ACTIVA'; if (em.on && box.parentElement) box.parentElement.open = true;
    box.innerHTML = `<div class="banner" style="${em.on ? '' : 'display:none'}"><b>PARADA DE EMERGENCIA ACTIVA.</b> No sale ninguna orden real nueva. ${esc(em.reason || '')}</div>
      <p class="muted" style="font-size:12px">${esc(r.policy)}</p>
      ${p ? `<p class="muted" style="font-size:12px">Límites de la plataforma (el menor entre cliente y plataforma manda): orden máx. <b>$${p.maxOrderUsd}</b> · día máx. <b>$${p.maxDailyUsd}</b> · abiertas máx. <b>${p.maxOpenOrders}</b> · órdenes/hora <b>${p.maxOrdersPerHour}</b> · precio máx. <b>${Math.round(p.maxPriceAgeMs / 1000)} s</b> · desvío máx. <b>${p.maxPriceDeviationPct}%</b> · rechazos seguidos <b>${p.maxConsecutiveRejects}</b>.</p>` : `<p class="neg">Los límites no se pueden leer: por seguridad no sale ninguna orden real. (${esc(r.platform_error || '')})</p>`}
      <label>Motivo (opcional)<input id="em_why" maxlength="120" placeholder="p. ej. comportamiento extraño del exchange"></label>
      <div class="row" style="margin-top:8px"><button class="btn ${em.on ? 'ghost' : ''}" id="em_btn">${em.on ? 'Levantar la emergencia' : 'ACTIVAR parada de emergencia'}</button></div>
      <div class="msg" id="em_m"></div>
      ${(r.recent || []).length ? `<details style="margin-top:8px"><summary class="muted" style="font-size:12px">Últimas decisiones de riesgo (${r.recent.length})</summary><div class="scroll"><table><tbody>${r.recent.map((a) => `<tr><td>${esc(ago(a.created_at))}</td><td>${a.action === 'risk_block' ? '<span class="neg">bloqueó</span>' : '<span class="pos">permitió</span>'}</td><td class="muted runs">${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}`;
    box.querySelector('#em_btn').addEventListener('click', async () => {
      try { await api('POST', '/api/owner/emergency', { on: !em.on, reason: box.querySelector('#em_why').value }); loadRiskCard(); } catch (e) { setMsg(box.querySelector('#em_m'), e.message); }
    });
  } catch (e) { if (!box.isConnected) return; box.innerHTML = `<p class="neg">${esc(e.message || 'error')}</p>`; }
}

async function tabAjustes(main) {
  let s = null;
  try { s = await api('GET', '/api/owner/settings'); } catch (e) { if (!(e.data && e.data.need_2fa_setup)) throw e; }
  main.innerHTML = `
  ${s ? '' : '<div class="banner">Por seguridad, activa la verificación en dos pasos (2FA) para usar la consola del dueño.</div>'}
  ${s ? `<div class="card"><h2>Plataforma</h2>
    <label>Trading REAL<select id="s_scope"><option value="off" ${s.live_scope === 'off' ? 'selected' : ''}>Apagado para todos</option><option value="owner" ${s.live_scope === 'owner' ? 'selected' : ''}>Solo yo (dueño): para probar con mi dinero</option><option value="on" ${s.live_scope === 'on' ? 'selected' : ''}>Todos los clientes</option></select></label>
    <p class="muted" style="font-size:12px;margin:4px 0 0">Empieza en “Solo yo” con montos mínimos. “Todos” solo después de probar y revisar los documentos legales con un abogado de Florida. Al apagarlo, los bots en real se detienen.</p>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="s_reg" ${s.registration_open ? 'checked' : ''}><span><b>Registro abierto</b> (nuevos clientes pueden crear cuenta).</span></label>
    <div class="row" style="margin-top:12px"><button class="btn" id="s_save">Guardar</button></div><div class="msg" id="sm"></div>
  </div>` : ''}
  ${s ? '<details class="card acc" id="riskc"><summary><h2>Riesgo y parada de emergencia</h2></summary><div class="accb" id="riskb"><p class="muted">Cargando…</p></div></details>' : ''}
  ${s ? '<details class="card acc" id="billc"><summary><h2>Planes y facturación</h2></summary><div class="accb" id="billb"><p class="muted">Cargando…</p></div></details>' : ''}
  <details class="card acc" id="expo"><summary><h2>Exportar Cerebro y app</h2></summary><div class="accb" id="expo_b"><p class="muted">Toca para cargar…</p></div></details>
  <div class="card"><h2>Verificación en dos pasos (2FA) para tu cuenta de dueño</h2>
    <p class="muted" style="font-size:13px">Estado: ${state.user.totp ? '<b class="pos">activada</b>' : '<b class="neg">desactivada</b>'}. Recomendado: actívala. Usa Google Authenticator, Authy o 1Password.</p>
    <div class="row"><button class="btn ghost" id="t_setup">${state.user.totp ? 'Cambiar 2FA' : 'Activar 2FA'}</button></div>
    <div id="t_box"></div>
  </div>`;
  if (s) { loadRiskCard(); $('#billc').addEventListener('toggle', () => { if ($('#billc').open && !$('#billc').dataset.l) { $('#billc').dataset.l = '1'; loadBillingCard(); } }); }
  $('#expo').addEventListener('toggle', async () => { if ($('#expo').open && !$('#expo').dataset.l) { $('#expo').dataset.l = '1'; try { await tabExport($('#expo_b')); } catch (err) { $('#expo_b').textContent = err.message; } } });
  if (s) $('#s_save').addEventListener('click', async () => {
    try { await api('PUT', '/api/owner/settings', { live_scope: $('#s_scope').value, registration_open: $('#s_reg').checked }); setMsg($('#sm'), 'Guardado.', true); state.me = await api('GET', '/api/me'); } catch (err) { setMsg($('#sm'), err.message); }
  });
  $('#t_setup').addEventListener('click', async () => {
    const r = await api('POST', '/api/owner/2fa/setup');
    $('#t_box').innerHTML = `<p>En tu app de autenticación elige "Ingresar clave de configuración" y pega esta clave:</p><p><code>${esc(r.secret)}</code></p>
      <div class="row"><input id="t_code" inputmode="numeric" maxlength="6" placeholder="Código de 6 dígitos" style="max-width:200px"><button class="btn" id="t_ok">Confirmar</button></div><div class="msg" id="tm"></div>`;
    $('#t_ok').addEventListener('click', async () => {
      try { await api('POST', '/api/owner/2fa/enable', { code: $('#t_code').value }); state.user.totp = true; setMsg($('#tm'), '2FA activada. Ya puedes usar la consola.', true); setTimeout(loadTab, 900); } catch (err) { setMsg($('#tm'), err.message); }
    });
  });
}

// ============================ Arranque ============================
// Enlaces del correo: #reset=TOKEN y #verify=TOKEN. El token se quita de la barra de direcciones de inmediato.
async function consumeMailLinks() {
  const bm = String(location.hash).match(/^#billing=(return|cancel)$/);
  if (bm) { history.replaceState(null, '', location.pathname + location.search); state.flash = bm[1] === 'return' ? 'Gracias. Tu plan se activa cuando el procesador de pagos lo confirme (puede tardar un minuto). Revisa Cuenta → Mi plan.' : 'Pago cancelado. No se te cobró nada.'; if (bm[1] === 'return') state.tab = 'cuenta'; return; }
  const m = String(location.hash).match(/^#(reset|verify)=([A-Za-z0-9_-]{20,200})$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (m[1] === 'reset') { state.authMode = 'reset'; state.resetToken = m[2]; return; }
  try { await api('POST', '/api/auth/verify-email', { token: m[2] }); state.flash = 'Correo verificado. ¡Gracias!'; }
  catch (e) { state.flash = e.message; }
}

async function boot() {
  await consumeMailLinks();
  try {
    state.me = await api('GET', '/api/me');
    state.user = state.me.user;
    if (!state.tab || (state.tab.startsWith('o_') && state.user.role !== 'owner')) state.tab = 'resumen';
    if (state.authMode === 'reset') state.authMode = 'login';
  } catch { state.user = null; }
  render();
}

// ---- Noticias en vivo: vigilante cada 90 s, radio (audio) y avisos. Solo lectura; los avisos del navegador funcionan con la app abierta. ----
let nwTimer = null; let nwItems = []; let radioOn = false;
const NSENT = (i) => (i.neg ? '<b class="neg" title="negativa">▼</b>' : i.pos ? '<b class="pos" title="positiva">▲</b>' : '<b class="muted">•</b>');
const newsListHtml = (items) => (items && items.length ? items.slice(0, 12).map((i) => `<div class="nrow">${NSENT(i)}<div class="nbody"><div class="ntit">${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title)}</div><div class="nmeta">${esc(i.src || 'noticias')} · ${esc(agoNews(i.t))} ${(i.coins || []).map((c) => `<span class="chip">${esc(c)}</span>`).join(' ')}</div></div></div>`).join('') : '<p class="muted">Sin titulares todavía.</p>');
const notifState = () => (!('Notification' in window) ? 'no' : Notification.permission === 'granted' && nstore.get('notif') ? 'on' : 'off');
function newsCardHtml(nw) {
  nwItems = (nw && nw.items) || nwItems;
  return `<div class="card" data-open id="nws"><h2>Noticias de trading en vivo</h2>
    <div class="nctl"><button type="button" class="btn small ${radioOn ? '' : 'ghost'}" id="nws_radio" aria-pressed="${radioOn}">${radioOn ? '⏹ Parar radio' : '📻 Radio en vivo'}</button>
    <button type="button" class="btn small ${notifState() === 'on' ? '' : 'ghost'}" id="nws_notif">${notifState() === 'on' ? '🔔 Avisos activados' : '🔔 Avisarme'}</button></div>
    <div class="msg" id="nws_m"></div><div id="nws_list">${newsListHtml(nwItems)}</div>
    <p class="muted" style="font-size:11px;margin:6px 0 0">Titulares públicos (CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine), en inglés; se actualizan cada 5 min. ▼ negativa, ▲ positiva. Solo informan y frenan compras ante noticias negativas; no predicen precios. Los avisos llegan también con la app cerrada si tu navegador lo permite (en iPhone, añade la app a la pantalla de inicio).</p></div>`;
}
function readNews(list) { for (const i of list) { voice.radio(introFor(i, lang() === 'en')); voice.radio(i.title, 'en'); } }
function bindNewsCard() {
  const rb = $('#nws_radio'); const nb = $('#nws_notif'); const m = $('#nws_m'); if (!rb || rb.dataset.b) return; rb.dataset.b = '1';
  rb.onclick = () => { if (!voice.supported) { m.textContent = 'Tu navegador no tiene voz para leer noticias.'; return; } radioOn = !radioOn; if (radioOn) { readNews(nwItems.slice(0, 4)); m.textContent = ''; } else voice.stopRadio(); rb.textContent = radioOn ? '⏹ Parar radio' : '📻 Radio en vivo'; rb.classList.toggle('ghost', !radioOn); rb.setAttribute('aria-pressed', String(radioOn)); };
  nb.onclick = async () => {
    const canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!('Notification' in window)) { m.textContent = 'Este navegador no permite avisos. Verás las noticias nuevas dentro de la app mientras esté abierta. (En iPhone: añade la app a la pantalla de inicio.)'; return; }
    const refresh = () => { nb.textContent = notifState() === 'on' ? '🔔 Avisos activados' : '🔔 Avisarme'; nb.classList.toggle('ghost', notifState() !== 'on'); };
    if (notifState() === 'on') {
      nstore.set('notif', false);
      if (canPush) { try { const reg = await navigator.serviceWorker.getRegistration('/'); const sub = reg && await reg.pushManager.getSubscription(); if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); } } catch { /* ignora */ } }
      m.textContent = ''; refresh(); return;
    }
    let p = Notification.permission; if (p === 'default') { try { p = await Notification.requestPermission(); } catch { p = 'denied'; } }
    if (p !== 'granted') { m.textContent = 'El permiso de avisos está bloqueado en tu navegador. Actívalo en los ajustes del sitio.'; refresh(); return; }
    nstore.set('notif', true); m.textContent = '';
    if (canPush) {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready;
        const { key } = await api('GET', '/api/push/key'); const pad = '='.repeat((4 - (key.length % 4)) % 4); const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/')); const k = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k });
        await api('POST', '/api/push/subscribe', { endpoint: sub.endpoint }); m.textContent = 'Listo: te avisaré aunque cierres la app.';
      } catch { m.textContent = 'Avisos activados mientras la app esté abierta. Tu navegador no completó los avisos con la app cerrada (en iPhone hay que añadir la app a la pantalla de inicio).'; }
    }
    try { new Notification('🔔 Avisos activados', { body: 'Te avisaré de las noticias nuevas de trading.', tag: 'qt-news' }); } catch { /* ignora */ }
    refresh();
  };
}
function newsToast(note) {
  if (!note) return; let t = $('#ntoast'); if (!t) { t = document.createElement('div'); t.id = 'ntoast'; t.setAttribute('role', 'status'); document.body.appendChild(t); t.onclick = () => { t.classList.remove('on'); if (state.user && state.tab !== 'mercado') { state.tab = 'mercado'; render(); } }; }
  t.innerHTML = `<b>${esc(note.title)}</b><span>${esc(note.body)}</span>`; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 9000);
}
async function pollNews(first) {
  try {
    const n = await api('GET', '/api/news'); nwItems = n.items || []; const seen = nstore.seen(); const fresh = freshItems(nwItems, seen);
    if (first && seen.size === 0) { nwItems.forEach((i) => seen.add(keyOf(i))); nstore.saveSeen(seen); }
    else if (fresh.length) {
      fresh.forEach((i) => seen.add(keyOf(i))); nstore.saveSeen(seen); const note = notifyFor(fresh); newsToast(note);
      if (nstore.get('notif') && 'Notification' in window && Notification.permission === 'granted') { try { new Notification(note.title, { body: note.body, tag: note.tag }); } catch { /* ignora */ } }
      if (radioOn) readNews(fresh.slice(0, 3));
    }
    const l = $('#nws_list'); if (l) l.innerHTML = newsListHtml(nwItems);
  } catch { /* sin red: se reintenta */ }
}
function startNewsWatch() { if (nwTimer) return; pollNews(true); nwTimer = setInterval(() => pollNews(false), 90000); }
function stopNewsWatch() { if (nwTimer) clearInterval(nwTimer); nwTimer = null; radioOn = false; voice.stopRadio(); }

// ---- Máquina del Tiempo: futuros posibles (simulación) y viaje al pasado. No es predicción. ----
let lastFuture = '';
const fpx = (v) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toPrecision(3));
const pct1 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;
function fanSvg(d) {
  const W = 320; const H = 150; const h = d.history; const nH = h.length; const nF = d.days; const all = [...h, ...d.bands.p5, ...d.bands.p95]; const mn = Math.min(...all); const mx = Math.max(...all); const pad = (mx - mn) * 0.06 || 1;
  const x = (i) => (i / (nH + nF - 1)) * (W - 4) + 2; const y = (v) => H - 6 - ((v - (mn - pad)) / (mx - mn + 2 * pad)) * (H - 12);
  const line = (arr, off) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(off + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = (lo, hi) => `${lo.map((v, i) => `${i ? 'L' : 'M'}${x(nH + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')} ${hi.map((v, i) => `L${x(nH + nF - 1 - i).toFixed(1)} ${y(hi[nF - 1 - i]).toFixed(1)}`).join(' ')}Z`;
  return `<svg viewBox="0 0 ${W} ${H}" class="tmsvg" role="img" aria-label="Pasado y futuros posibles"><line x1="${x(nH - 1)}" x2="${x(nH - 1)}" y1="2" y2="${H - 2}" class="tmnow"/><path d="${area(d.bands.p5, d.bands.p95)}" class="tm90"/><path d="${area(d.bands.p25, d.bands.p75)}" class="tm50"/><path d="${line(h, 0)}" class="tmpast"/><path d="${line(d.bands.p50, nH)}" class="tmmed"/></svg>`;
}
function futureHtml(d) {
  const up = Math.round(d.prob_up * 100);
  const txt = `${d.symbol} en ${d.days} días: en la mitad de los futuros simulados termina ${pct1(d.median_pct)}; el rango del 90 % va de ${pct1(d.range90_pct[0])} a ${pct1(d.range90_pct[1])}. Sube en ${up} de cada 100 escenarios y en ${Math.round(d.prob_drop10 * 100)} de cada 100 pasa por una caída de 10 % o más. No es una predicción.`;
  lastFuture = txt;
  return `${fanSvg(d)}<div class="tmleg"><span><i class="tpast"></i>pasado 90 d</span><span><i class="tmedc"></i>mediana</span><span><i class="t50"></i>50 % de los casos</span><span><i class="t90"></i>90 % de los casos</span></div>
    <div class="tmgrid"><div><small>Mediana en <span>${d.days}</span> d</small><b class="${cls(d.median_pct)}">${pct1(d.median_pct)}</b></div><div><small>Rango 90 %</small><b>${pct1(d.range90_pct[0])} · ${pct1(d.range90_pct[1])}</b></div><div><small>Prob. de subir</small><b>${up} %</b></div><div><small>Caída ≥ 10 % en el camino</small><b>${Math.round(d.prob_drop10 * 100)} %</b></div></div>
    <div class="tmrep"><b>🕰 Viaje al pasado</b> <span>(si hubieras comprado antes, sin costos)</span>${d.replay.map((r) => `<div><span>${r.days} d:</span> <b class="${cls(r.ret_pct)}">${pct1(r.ret_pct)}</b> <span>peor caída</span> <b>${pct1(r.max_drawdown_pct)}</b></div>`).join('')}</div>
    <div class="muted" style="font-size:12px;margin-top:6px"><span>Contexto:</span> <span>tendencia</span> <b>${esc(d.context.trend)}</b> · <span>RSI</span> <b>${d.context.rsi}</b> · <b>${esc(d.regime)}</b> · <span>${d.kind}, movimiento típico diario</span> <b>${d.vol_daily_pct.toFixed(1)} %</b> · <span>Precio hoy</span> <b>${money(d.start, d.start < 10 ? 4 : 2)}</b></div>
    <div class="row" style="margin-top:8px"><button type="button" class="btn small ghost" id="tm_say">🔊 Contármelo</button></div>
    <p class="muted" style="font-size:11px;margin:6px 0 0"><span>${esc(d.note)}</span> <span>Simulación con</span> <b>${d.paths.toLocaleString('en-US')}</b> <span>caminos.</span></p>`;
}
function futureCardHtml(coins) {
  const opts = [...new Set([...(coins || []).map((c) => c.symbol), 'BTC-USD', 'ETH-USD', 'SOL-USD', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'SPY'])].map((s) => `<option value="${esc(s)}"></option>`).join('');
  return `<div class="card" data-open id="tmc"><h2>Máquina del Tiempo</h2><p class="muted" style="margin:0 0 8px;font-size:13px">Elige una cripto o una acción y viaja a miles de futuros posibles, con probabilidades reales. No predice: simula.</p>
    <div class="tmctl"><input id="tm_sym" list="tm_list" value="BTC-USD" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Símbolo"><datalist id="tm_list">${opts}</datalist>
    <select id="tm_days" aria-label="Días"><option value="7">7 días</option><option value="30" selected>30 días</option><option value="90">90 días</option></select><button type="button" class="btn small" id="tm_go">🕰 Viajar al futuro</button></div>
    <div id="tm_out" class="muted" style="margin-top:8px"></div></div>`;
}
function bindFuture() {
  const go = $('#tm_go'); if (!go || go.dataset.b) return; go.dataset.b = '1'; const out = $('#tm_out');
  const run = async () => {
    const sym = ($('#tm_sym').value || '').trim().toUpperCase().replace(/\s+/g, ''); if (!sym) return; const sy = /-/.test(sym) ? sym : (['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC'].includes(sym) ? `${sym}-USD` : sym);
    out.className = 'muted'; out.textContent = 'Viajando… simulando miles de futuros'; go.disabled = true;
    try { const d = await api('GET', `/api/future?symbol=${encodeURIComponent(sy)}&days=${$('#tm_days').value}`); out.className = ''; out.innerHTML = futureHtml(d); const s = $('#tm_say'); if (s) s.onclick = () => voice.radio(lastFuture); }
    catch (e) { out.className = 'neg'; out.textContent = e.message; } finally { go.disabled = false; }
  };
  go.onclick = run; $('#tm_sym').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

function render() {
  if (!state.user) { stopNewsWatch(); return viewAuth(); }
  startNewsWatch(); voice.refresh();
  shell();
  loadTab().then(() => { if (state.flash) { const b = document.createElement('div'); b.className = 'banner'; b.textContent = state.flash; state.flash = ''; const m = $('#main'); if (m) m.prepend(b); } });
}

window.addEventListener('hashchange', () => { if (/^#(reset|verify)=|^#billing=/.test(location.hash)) boot(); }); // enlace del correo abierto en una pestaña que ya estaba abierta
boot();
