// Interfaz de Quantum Trading. Sin librerías; todo dato dinámico pasa por esc() antes de insertarse.
import { genEd25519 } from '/keygen.js';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }));
const num = (n, d = 6) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

const state = { user: null, me: null, tab: 'resumen', authMode: 'login', needTotp: false };

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
function viewAuth() {
  const reg = state.authMode === 'register';
  $('#root').innerHTML = `
  <div class="auth">
    <div class="brand"><small>RDCMNATION</small>Quantum Trading</div>
    <div class="card">
      <div class="tabs"><button data-m="login" class="${reg ? '' : 'on'}">Entrar</button><button data-m="register" class="${reg ? 'on' : ''}">Crear cuenta</button></div>
      <form id="f" class="form" style="margin-top:14px" autocomplete="on">
        <label class="full">Correo<input name="email" type="email" required autocomplete="username"></label>
        <label class="full">Contraseña${reg ? ' (mínimo 10 caracteres)' : ''}<input name="password" type="password" required minlength="${reg ? 10 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        ${state.needTotp ? '<label class="full">Código 2FA (6 dígitos)<input name="totp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>' : ''}
        ${reg ? `<label class="check full"><input type="checkbox" name="tos" required><span>Soy mayor de 18 años y acepto los <a href="/legal.html#terminos" target="_blank" rel="noopener">Términos</a>, la <a href="/legal.html#privacidad" target="_blank" rel="noopener">Privacidad</a> y el <a href="/legal.html#riesgo" target="_blank" rel="noopener">Aviso de riesgo</a>. Entiendo que esto no es asesoría financiera y que puedo perder dinero.</span></label>` : ''}
        <button class="btn full" type="submit">${reg ? 'Crear cuenta' : 'Entrar'}</button>
        <div class="msg full" id="m"></div>
      </form>
    </div>
    <p class="muted" style="font-size:12px">Cada cuenta es privada: ningún cliente puede ver los datos de otro.</p>
  </div>`;
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.authMode = b.dataset.m; state.needTotp = false; viewAuth(); }));
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const m = $('#m');
    try {
      const r = await api('POST', reg ? '/api/auth/register' : '/api/auth/login',
        reg ? { email: f.email, password: f.password, acceptTos: f.tos === 'on' } : { email: f.email, password: f.password, totp: f.totp });
      state.user = r.user; state.needTotp = false; state.tab = r.user.role === 'owner' ? 'o_hoy' : 'resumen';
      await boot();
    } catch (err) {
      if (err.data && err.data.need_totp) { state.needTotp = true; viewAuth(); $('#m').textContent = err.message; $('#m').className = 'msg err'; return; }
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
const AUTO_PRESET = { autoMode: 'pro', symbol: 'AUTO', strategy: 'sma', usd: 25, intervalMin: 60, fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60, stopLossPct: 8, mode: 'paper', paperExchange: 'best', maxPositions: 3, maxOrderUsd: 25, maxDailyUsd: 100, enabled: true };
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
    ${b.recent.length ? `<div class="scroll" style="margin-top:6px"><table><tbody>${b.recent.slice(0, 6).map((o) => `<tr><td>${esc(ago(o.t))}</td><td>${o.side === 'buy' ? 'Compra' : 'Venta'} ${esc(o.symbol)} <span class="chip ${o.mode === 'live' ? 'live' : 'paper'}">${o.mode === 'live' ? 'REAL' : 'papel'}</span></td><td class="r">${money(o.usd)}</td><td>${o.status === 'ok' ? '<span class="pos">ok</span>' : `<span class="neg">${esc(o.status)}</span>`}</td></tr>${o.status !== 'ok' && o.note ? `<tr><td colspan="4" class="neg" style="white-space:normal;font-size:12px;padding-top:0">↳ ${esc(o.note)}</td></tr>` : ''}`).join('')}</tbody></table></div>` : ''}
    ${b.enabled ? '<p class="muted" style="font-size:11px;margin:6px 0 0">El bot trabaja mientras el servidor está despierto. En el plan gratis de Render se duerme sin visitas; con un plan de pago de Render queda siempre despierto.</p>' : ''}`;
}
const until = (t) => { if (!t) return '—'; const m = Math.round((t - Date.now()) / 60000); return m <= 0 ? 'en breve' : m < 60 ? `en ${m} min` : `en ${Math.round(m / 60)} h`; };
function dashHtml(d) {
  const r = d.real; const p = d.paper; const br = d.brain;
  const none = !r.orders && !r.errors;
  const rows = r.last.map((o) => `<tr><td>${esc(ago(o.t))}</td><td>${o.side === 'buy' ? 'Compra' : 'Venta'} <b>${esc(o.symbol.replace('-USD', ''))}</b> <span class="chip">${esc(o.exchange)}</span></td><td class="r">${money(o.usd)}</td><td>${o.status === 'ok' ? '<span class="pos">ok</span>' : '<span class="neg">error</span>'}</td></tr>${o.note ? `<tr><td colspan="4" class="neg" style="white-space:normal;font-size:12px;padding-top:0">↳ ${esc(o.note)}</td></tr>` : ''}`).join('');
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
      <div class="muted" style="font-size:12px">resultado total real · ${money(r.realized)} cerrado · ${r.unrealized === null ? '—' : money(r.unrealized)} abierto</div>
      <div class="kpis" style="margin-top:8px"><div class="kpi"><div class="l">Invertido ahora</div><div class="v" style="font-size:16px">${money(r.invested_now)}</div></div>
        <div class="kpi"><div class="l">Compras / ventas</div><div class="v" style="font-size:16px">${r.orders}</div><div class="s">${money(r.bought, 0)} / ${money(r.sold, 0)}</div></div>
        <div class="kpi"><div class="l">Errores</div><div class="v ${r.errors ? 'neg' : ''}" style="font-size:16px">${r.errors}</div></div></div>
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
      try { await quickStart({ symbol: 'AUTO', autoMode: 'pro', strategy: 'sma', usd, intervalMin: 60, fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60, stopLossPct: 8, mode: 'live', connectionId: f.conn.value,
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
const tagOf = (txt) => (/compra|buy|rota/i.test(txt) && !/vende|stop/i.test(txt) ? ['COMPRA', 'buy'] : /vend|stop|sell|rota:/i.test(txt) ? ['VENTA', 'sell'] : /mantiene|vigila|espera|pausa|descansa|freno|límite/i.test(txt) ? ['VIGILA', 'hold'] : ['NOTA', '']);
const vizStat = (d) => d.stats.map((x) => `<div><b>${esc(x[1])}</b>${esc(x[0])}</div>`).join('');
const vizRows = (d) => (d.rows && d.rows.length ? d.rows.map((r) => `<div class="br ${r.kind}"><b>${esc(r.sym)}</b><span>${esc(r.state)}</span><span class="num">${r.score ? r.score.toFixed(1) : '—'}</span><span class="num">${esc(r.note)}</span></div>`).join('') : '');
const vizStream = (d) => d.stream.slice(0, 14).map((x) => { const [tg, c] = tagOf(x.text); return `<div><span class="tg ${c}">${tg}</span>${x.t ? `<span>${esc(ago(x.t))} · </span>` : ''}${esc(x.text)}</div>`; }).join('') || '<div>Esperando la primera decisión…</div>';
function vizHtml(d, id) {
  return `<div class="bviz" id="${id}"><canvas aria-label="${esc(d.caption)}"></canvas><span class="bcap">${esc(d.caption)}</span>
    <div class="bstat">${vizStat(d)}</div><div class="brows" ${d.rows && d.rows.length ? '' : 'hidden'}>${vizRows(d)}</div>
    <div class="bstream">${vizStream(d)}</div><div class="bappr">${esc(d.approval)}</div></div>`;
}
function vizFill(root, d) {
  $('.bcap', root).textContent = d.caption; $('.bstat', root).innerHTML = vizStat(d); const r = $('.brows', root); r.innerHTML = vizRows(d); r.hidden = !(d.rows && d.rows.length); $('.bstream', root).innerHTML = vizStream(d);
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
  const rows = octo ? octo.items.map((it) => ({ sym: base(it.symbol), state: (OSTATE[it.state] || [0, it.state])[1], kind: (OSTATE[it.state] || ['idle'])[0], score: it.score, note: it.held ? `${it.gain_pct >= 0 ? '+' : ''}${(it.gain_pct || 0).toFixed(2)} %` : it.edge ? `${it.edge.toFixed(1)}× costo` : '' })) : null;
  return { center: 'IA', nodes, stream, rows, live: bn.enabled, octopus: !!octo, caption: bn.enabled ? (octo ? 'Pulpo · en vivo' : 'Cerebro · en vivo') : 'Cerebro · apagado',
    stats: [['posiciones', held.length], ['validadas', ok.length], ['mercado', rg || '—'], ['revisó', agoS(bn.last_run)]],
    approval: 'Tú mandas: topes por orden y por día, botón de apagado y trading real solo con tu confirmación.' };
}
function agentsViz(b) {
  const nodes = b.agents.map((a) => ({ label: (a.label || a.name).split(' ')[0].slice(0, 10), kind: !a.available ? 'off' : a.enabled ? 'ok' : 'idle' }));
  const stream = [];
  for (const r of (b.runs || []).slice(0, 4)) for (const a of r.agents) for (const n of (a.notes || []).slice(0, 2)) stream.push({ t: r.t, text: `${a.agent}: ${n}` });
  return { center: 'DIR', nodes, stream: stream.slice(0, 14), live: true, caption: 'Director + agentes',
    stats: [['agentes activos', b.agents.filter((a) => a.enabled).length], ['pendientes tuyos', b.pending.length], ['versión', 'v' + b.brain_version], ['última corrida', ago(b.last_run)]],
    approval: b.pending.length ? `Solo tú apruebas: ${b.pending.length} propuesta(s) esperan tu decisión.` : 'Solo tú apruebas los cambios críticos. Nada pendiente ahora.' };
}

let vizCtl = null;
function mountViz(bn) { const r = $('#bz_v'); if (r) vizCtl = brainViz(r, botViz(bn)); }
// Actualiza el pulpo SIN recrearlo: los tentáculos se deslizan hacia sus nuevos pesos.
function updateViz(bn) { const r = $('#bz_v'); if (!r) return; if (vizCtl && r.dataset.on === '1') { const d = botViz(bn); vizCtl.update(d); vizFill(r, d); } else { r.dataset.on = '1'; mountViz(bn); } }
const myBotCards = (bn) => `<div class="card" data-open id="pf"><h2>Ganado desde que se encendió el bot</h2><div id="pf_c" class="muted">Calculando…</div></div>
  <div class="card" data-open id="dash"><h2>Tablero · dinero real primero</h2><div id="dash_b" class="muted">Cargando…</div></div>
  <div class="card" data-open id="botnow"><h2>Mi bot ahora</h2><div id="botnow_b">${botNowHtml(bn)}</div></div>
  <div class="card" data-open id="bz"><h2>Cerebro en vivo</h2><div id="bz_b">${vizHtml(botViz(bn), 'bz_v')}</div></div>
  <div class="card" data-open id="pc"><h2>Gráfico de precio</h2><div id="pc_c">${priceCardHtml(bn)}</div></div>
  <div class="card" data-open><h2>Mis exchanges en vivo <button class="btn ghost small" id="live_r" type="button" style="margin-left:8px">↻</button></h2><div id="live_b" class="muted">Leyendo tu exchange…</div></div>`;
function startMyBot(bn) {
  bindBotNow(); refreshLive(); refreshDash(); loadProfit(bn.mode); bindPrice(); mountViz(bn); { const r = $('#bz_v'); if (r) r.dataset.on = '1'; }
  const lr = $('#live_r'); if (lr) lr.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); refreshLive(true); });
  let n = 0; let waiting = bn.enabled && !bn.last; let on = bn.enabled;
  tabTimer = setInterval(async () => {
    n++; if (n % 8 === 0) { refreshLive(); refreshDash(); loadProfit(bn.mode); }
    if (!(waiting || (on && n % 2 === 0) || n % 8 === 0)) return; // con el bot encendido, el pulpo se actualiza cada ~8 s
    try { const b = await api('GET', '/api/bot/status'); const el = $('#botnow_b'); if (el) { if (!el.contains(document.activeElement)) { el.innerHTML = botNowHtml(b); bindBotNow(); } updateViz(b); } waiting = b.enabled && !b.last; on = b.enabled; } catch { /* reintenta en el próximo ciclo */ }
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
    <button class="btn ghost small" data-bal="${esc(c.id)}">Saldos</button><button class="btn danger small" data-del="${esc(c.id)}">Quitar</button></div>`).join('');
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
      <label class="nodca">Stop-loss % (0 = sin stop)<input name="stopLossPct" type="number" min="0" max="50" step="any" value="${esc(cfg.stopLossPct ?? 8)}"></label>
      <label>Modo<select name="mode">${opt('paper', cfg.mode, 'Papel (simulado, sin dinero)')}${opt('live', cfg.mode, live ? 'REAL (dinero real)' : 'REAL (no habilitado todavía)')}</select></label>
      <label class="real">Conexión para operar<select name="connectionId"><option value="">— elegir —</option>${connections.map((c) => opt(c.id, cfg.connectionId, `${c.exchange} · ${c.label}`)).join('')}</select></label>
      <label class="real">Tope por orden (USD, máx. ${money(state.me.limits.hardMaxOrder, 0)})<input name="maxOrderUsd" type="number" min="1" step="any" value="${esc(cfg.maxOrderUsd)}"></label>
      <label class="real">Tope diario de compras (USD, máx. ${money(state.me.limits.hardMaxDaily, 0)})<input name="maxDailyUsd" type="number" min="1" step="any" value="${esc(cfg.maxDailyUsd)}"></label>
      <label class="check full real"><input type="checkbox" name="sizing" ${cfg.sizing === 'balance' ? 'checked' : ''}><span>Usar el saldo disponible en mi exchange (se reparte entre posiciones y nunca pasa los topes de abajo)</span></label>
      <label class="check full real"><input type="checkbox" name="liveAck" ${cfg.liveAck ? 'checked' : ''}><span>Entiendo que el modo REAL usa mi dinero, que puedo perder todo lo que invierta, que los resultados pasados o simulados no garantizan resultados futuros y que Quantum Trading no es asesor financiero.</span></label>
      <label class="check full"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}><span><b>Bot encendido</b></span></label>
      <div class="full row"><button class="btn" type="submit">Guardar</button><button class="btn danger" type="button" id="kill">Apagar ya</button></div>
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
      slow: f.slow.value, rsiBuy: f.rsiBuy.value, rsiSell: f.rsiSell.value, stopLossPct: f.stopLossPct.value, mode: f.mode.value, connectionId: f.connectionId.value || null, maxOrderUsd: f.maxOrderUsd.value,
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
  $('#kill').addEventListener('click', async () => {
    try { await api('POST', '/api/bot/kill'); $('#bf').enabled.checked = false; setMsg($('#bm'), 'Bot apagado.', true); } catch (err) { setMsg($('#bm'), err.message); }
  });
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
  <div class="card"><h2>Mis datos</h2>
    <p class="muted" style="font-size:13px">Descarga una copia de tu perfil, configuración y órdenes. Tus llaves API no se incluyen.</p>
    <a class="btn ghost" href="/api/me/export" download>Descargar mis datos (JSON)</a>
  </div>
  ${state.user.role === 'owner' ? '' : `<div class="card"><h2>Eliminar mi cuenta</h2>
    <p class="muted" style="font-size:13px">Borra tu cuenta, tus llaves cifradas, tu bot y tus órdenes. No se puede deshacer.</p>
    <form id="df" class="form"><label>Tu contraseña<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn danger full" type="submit">Eliminar cuenta definitivamente</button><div class="msg full" id="dm"></div></form></div>`}`;
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
  const agents = b.agents.map((a) => { const lr = lastRun(a.name); const x = st[a.name] || {}; return `<tr><td><b>${esc(a.label)}</b></td>
    <td>${a.available ? (a.enabled ? '<span class="pos">activo</span>' : 'apagado') : '<span class="muted">próximamente</span>'}</td>
    <td class="muted" style="white-space:normal">${lr ? `${ago(lr.t)}${lr.error ? ' · <span class="neg">error</span>' : ''}` : '—'}</td>
    <td class="r muted" title="corridas / propuestas / aplicadas / rechazadas">${a.available ? `${x.runs || 0} · ${x.created || 0} · <span class="pos">${x.applied || 0}</span> · ${x.rejected || 0}` : ''}</td>
    <td class="r">${a.available ? `<button class="btn ghost small" data-ag="${esc(a.name)}" data-en="${a.enabled ? '0' : '1'}">${a.enabled ? 'Apagar' : 'Encender'}</button>` : ''}</td></tr>`; }).join('');
  const pend = b.pending.map((p) => `<div class="prop"><div class="row"><span class="chip">${esc(KIND_LABEL[p.kind] || p.kind)}</span><span class="muted" style="font-size:12px">${esc(p.agent || '')}</span></div>
    <div style="margin:6px 0"><b>${esc(p.title)}</b></div>
    <details><summary class="muted" style="font-size:12px;cursor:pointer">Datos</summary><pre style="white-space:pre-wrap;font-size:11px;overflow-x:auto">${esc(JSON.stringify(p.evidence, null, 1))}</pre></details>
    <div class="row" style="margin-top:8px">${APPLIES.includes(p.kind) ? `<button class="btn small" data-dec="approve" data-id="${esc(p.id)}">Aprobar</button>` : `<button class="btn ghost small" data-dec="approve" data-id="${esc(p.id)}">Enterado</button>`}
    <button class="btn ghost small" data-dec="reject" data-id="${esc(p.id)}">Rechazar</button></div></div>`).join('');
  const runs = b.runs.slice(0, 8).map((r) => `<tr><td>${esc(ago(r.t))}</td><td>${esc(r.trigger)}</td><td>${r.agents.map((a) => `${esc(a.agent)}: ${a.error ? '✗' : a.created}`).join(' · ')}</td></tr>`).join('');
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
  <div class="card"><h2>Agentes</h2><p class="muted" style="font-size:11px;margin:0 0 6px">Estado · última corrida · corridas · propuestas · aplicadas · rechazadas</p><div class="scroll"><table><tbody>${agents}</tbody></table></div><div class="msg" id="ag_m"></div></div>
  <div class="card"><h2>Corridas</h2>${runs ? `<div class="scroll"><table><tbody>${runs}</tbody></table></div>` : '<p class="muted">Sin corridas.</p>'}</div>
  <details class="card"><summary><h2 style="display:inline">Modelos ML</h2></summary><div class="scroll"><table><thead><tr><th>Par</th><th>Estado</th><th>Precisión vs base</th></tr></thead><tbody>${models}</tbody></table></div></details>
  <details class="card"><summary><h2 style="display:inline">Historial (${b.history.length})</h2></summary>${hist ? `<div class="scroll"><table><tbody>${hist}</tbody></table></div>` : '<p class="muted">Vacío.</p>'}</details>
  <details class="card"><summary><h2 style="display:inline">Límites inviolables</h2></summary>
    <form id="gf" class="form" style="margin-top:10px">
      <label>Máx. pendientes<input name="maxPendingProposals" type="number" min="1" max="100" value="${esc(g.maxPendingProposals)}"></label>
      <label>Auto-corrida (horas)<input name="autoRunHours" type="number" min="1" max="168" value="${esc(g.autoRunHours)}"></label>
      <label class="full">Tipos permitidos<span class="row">${Object.keys(KIND_LABEL).map((k) => `<label class="check"><input type="checkbox" name="kind_${k}" ${g.allowedKinds.includes(k) ? 'checked' : ''}><span>${esc(KIND_LABEL[k])}</span></label>`).join('')}</span></label>
      <p class="muted full" style="font-size:12px">Protegido: ${g.protectedAreas.map((a) => `<code>${esc(a)}</code>`).join(' ')}</p>
      <button class="btn full" type="submit">Guardar</button><div class="msg full" id="gm"></div></form></details>`;
  brainViz($('#ag_v'), agentsViz(b));
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
  <div class="card" data-open><h2>Precios y tendencia</h2>${coins ? `<div class="scroll"><table><thead><tr><th>Par</th><th class="r">Precio</th><th class="r">24 h</th><th class="r">7 d</th><th class="r">30 d</th></tr></thead><tbody>${coins}</tbody></table></div>` : '<p class="muted">Sin datos de CoinGecko ahora mismo.</p>'}</div>
  <div class="card" data-open><h2>Ranking del Cerebro: todas las criptos grandes</h2>${scannerHtml(sc)}</div>
  <div class="card"><h2>Noticias (freno de riesgo del bot)</h2>${nw && nw.items.length ? nw.items.slice(0, 8).map((i) => `<div style="padding:5px 0;border-bottom:1px solid var(--line);font-size:13px">${i.neg ? '<span class="neg">⚠</span> ' : ''}${esc(i.title)} ${i.coins.map((c) => `<span class="chip">${esc(c)}</span>`).join(' ')}</div>`).join('') : '<p class="muted">Sin titulares todavía.</p>'}<p class="muted" style="font-size:11px;margin:6px 0 0">Titulares públicos (CoinDesk, Cointelegraph). Solo detienen compras ante noticias negativas; no predicen precios.</p></div>
  <div class="card"><h2>Liquidez real (Coinbase Exchange)</h2>${books ? `<div class="scroll"><table><thead><tr><th>Par</th><th class="r">Spread</th><th class="r">Profundidad ±0.5 %</th><th class="r">Volumen 24 h</th></tr></thead><tbody>${books}</tbody></table></div>` : '<p class="muted">Sin libro de órdenes ahora mismo.</p>'}</div>
  <div class="card"><h2>Tendencia en CoinGecko</h2>${m.trending.length ? `<div class="row">${m.trending.map((t) => `<span class="chip">${esc(t.name)} ${esc(t.symbol.toUpperCase())}</span>`).join('')}</div>` : '<p class="muted">Sin datos.</p>'}</div>
  <p class="muted" style="font-size:12px">${esc(m.note)} Actualizado ${esc(ago(m.t))}.${m.errors.length ? ' Fuentes con problemas: ' + esc(m.errors.join('; ')) : ''}</p>`;
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
  <details class="card acc" id="expo"><summary><h2>Exportar Cerebro y app</h2></summary><div class="accb" id="expo_b"><p class="muted">Toca para cargar…</p></div></details>
  <div class="card"><h2>Verificación en dos pasos (2FA) para tu cuenta de dueño</h2>
    <p class="muted" style="font-size:13px">Estado: ${state.user.totp ? '<b class="pos">activada</b>' : '<b class="neg">desactivada</b>'}. Recomendado: actívala. Usa Google Authenticator, Authy o 1Password.</p>
    <div class="row"><button class="btn ghost" id="t_setup">${state.user.totp ? 'Cambiar 2FA' : 'Activar 2FA'}</button></div>
    <div id="t_box"></div>
  </div>`;
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
async function boot() {
  try {
    state.me = await api('GET', '/api/me');
    state.user = state.me.user;
    if (!state.tab || (state.tab.startsWith('o_') && state.user.role !== 'owner')) state.tab = 'resumen';
  } catch { state.user = null; }
  render();
}

function render() {
  if (!state.user) return viewAuth();
  shell();
  loadTab();
}

boot();
