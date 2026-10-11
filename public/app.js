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
const OWNER_TABS = [['o_hoy', 'Hoy'], ['o_cerebro', 'Cerebro'], ['o_launch', 'Lanzar'], ['o_clientes', 'Clientes'], ['o_seguridad', 'Seguridad'], ['o_ajustes', 'Ajustes']];
const ICONS = {
  resumen: '<path d="M4 13h6V4H4zM14 20h6V4h-6zM4 20h6v-4H4z"/>', mercado: '<path d="M3 17l5-5 4 4 8-9M15 7h5v5"/>', exchanges: '<path d="M9 7H6a3 3 0 000 6h3M15 7h3a3 3 0 010 6h-3M8 10h8"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01"/>', mas: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  o_hoy: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', o_cerebro: '<path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 0V7a3 3 0 00-3-3zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-3 2"/>',
  o_launch: '<path d="M5 19c1-4 3-7 7-10l3-4 4-1-1 4-4 3c-3 4-6 6-9 8zM9 15l-3 3"/>', o_clientes: '<circle cx="9" cy="9" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 7a3 3 0 010 6M18 15c2 1 3 2 3 4"/>',
};
const ico = (k) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.mas}</svg>`;

function shell() {
  const owner = state.user.role === 'owner';
  const inClient = !owner || state.showClient;
  const main5 = inClient ? [['resumen', 'Resumen'], ['mercado', 'Mercado'], ['bot', 'Bot'], ['exchanges', 'Conectar']] : [['o_hoy', 'Hoy'], ['o_cerebro', 'Cerebro'], ['o_launch', 'Lanzar'], ['o_clientes', 'Clientes']];
  const mainKeys = main5.map((x) => x[0]);
  const rest = (inClient ? CLIENT_TABS : OWNER_TABS).filter(([k]) => !mainKeys.includes(k));
  const inMore = !mainKeys.includes(state.tab);
  const btn = ([k, l]) => `<button data-t="${k}" class="${state.tab === k ? 'on' : ''}">${ico(k)}<span>${esc(l)}</span></button>`;
  const cur = [...CLIENT_TABS, ...OWNER_TABS].find(([k]) => k === state.tab);
  $('#root').innerHTML = `
  <div class="wrap">
    <div class="top">
      <div class="brand"><small>${owner ? (inClient ? 'Dueño · vista cliente' : 'Consola del dueño') : 'RDCMNATION'}</small>Quantum Trading</div>
      <div class="who"><span class="chip">${esc(cur ? cur[1] : '')}</span></div>
    </div>
    <div id="main"></div>
    <p class="muted" style="font-size:11px">No es asesoría de inversión ni custodia de fondos. Operar cripto implica riesgo de perder todo el dinero. <a href="/legal.html" target="_blank" rel="noopener">Legal</a></p>
  </div>
  <div class="bar" role="navigation">${main5.map(btn).join('')}<button id="more" class="${inMore ? 'on' : ''}">${ico('mas')}<span>Más</span></button></div>
  <div class="sheet" id="sheet" hidden><div class="sheetb">
    <div class="muted" style="font-size:12px;margin-bottom:6px">${esc(state.user.email)}</div>
    ${rest.map(([k, l]) => `<button class="item" data-t="${k}">${esc(l)}</button>`).join('')}
    ${owner ? `<button class="item" id="vc">${inClient ? '← Volver a la consola del dueño' : 'Ver como cliente'}</button>` : ''}
    <button class="item" id="out" style="color:var(--bad)">Salir</button>
  </div></div>`;
  const go = (k) => { state.tab = k; shell(); loadTab(); };
  document.querySelectorAll('.bar button[data-t], .sheet button[data-t]').forEach((b) => b.addEventListener('click', () => go(b.dataset.t)));
  $('#more').addEventListener('click', () => { $('#sheet').hidden = !$('#sheet').hidden; });
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });
  const vc = $('#vc'); if (vc) vc.addEventListener('click', () => { state.showClient = !state.showClient; go(state.showClient ? 'resumen' : 'o_hoy'); });
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
      o_launch: tabLaunch, o_cerebro: tabCerebro, o_export: tabExport, o_overview: tabOverview, o_clientes: tabClientes, o_seguridad: tabSeguridad, o_ajustes: tabAjustes }[state.tab];
    await fn(main);
    accordionize(main);
  } catch (e) { main.innerHTML = `<div class="card"><span class="neg">${esc(e.message)}</span></div>`; }
}

// ============================ Cliente ============================
const AUTO_PRESET = { symbol: 'AUTO', strategy: 'sma', usd: 25, intervalMin: 60, fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60, stopLossPct: 8, mode: 'paper', paperExchange: 'best', maxPositions: 3, maxOrderUsd: 25, maxDailyUsd: 100, enabled: true };
const DEMO_PRESET = { symbol: 'BTC-USD', strategy: 'dca', usd: 10, intervalMin: 15, mode: 'paper', paperExchange: 'best', maxOrderUsd: 25, maxDailyUsd: 100, enabled: true };
async function quickStart(preset) { await api('PUT', '/api/bot', preset); state.tab = 'resumen'; shell(); loadTab(); }
const cheapTxt = { coinbase: 'Coinbase', robinhood: 'Robinhood', igual: 'igual' };

function botNowHtml(b) {
  const actTxt = { buy: 'Comprar', sell: 'Vender', hold: 'Mantener' };
  const l = b.last; const auto = b.symbol === 'AUTO';
  const fresh = b.last_run && Date.now() - b.last_run < 180000;
  const status = !b.enabled ? '<span class="chip">Apagado</span>' : fresh ? '<span class="chip paper">● Activo</span>' : '<span class="chip">Esperando ciclo</span>';
  const p = b.position;
  const cta = b.enabled ? '' : `<div class="row" style="margin:8px 0"><button class="btn" id="bn_auto">▶ Encender Cerebro (papel)</button><button class="btn ghost" id="bn_demo">Demo: compra cada 15 min</button></div>`;
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
    ${b.recent.length ? `<div class="scroll" style="margin-top:6px"><table><tbody>${b.recent.slice(0, 5).map((o) => `<tr><td>${esc(ago(o.t))}</td><td>${o.side === 'buy' ? 'Compra' : 'Venta'} ${esc(o.symbol)}</td><td class="r">${money(o.usd)}</td><td>${o.status === 'ok' ? '<span class="pos">ok</span>' : `<span class="neg">${esc(o.status)}</span>`}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${b.enabled ? '<p class="muted" style="font-size:11px;margin:6px 0 0">El bot trabaja mientras el servidor está despierto. En el plan gratis de Render se duerme sin visitas: usa UptimeRobot sobre /api/health.</p>' : ''}`;
}
function bindBotNow() {
  const a = $('#bn_auto'); const d = $('#bn_demo');
  if (a) a.addEventListener('click', () => quickStart(AUTO_PRESET).catch((e) => alert(e.message)));
  if (d) d.addEventListener('click', () => quickStart(DEMO_PRESET).catch((e) => alert(e.message)));
}

async function tabResumen(main) {
  const [pnl, bot, conns, bn] = await Promise.all([api('GET', '/api/pnl'), api('GET', '/api/bot'), api('GET', '/api/connections'), api('GET', '/api/bot/status')]);
  const rows = pnl.positions.map((p) => `<tr><td><span class="chip ${esc(p.mode)}">${p.mode === 'live' ? 'REAL' : 'PAPEL'}</span></td><td>${esc(p.symbol)}</td>
    <td class="r">${num(p.qty, 8)}</td><td class="r">${money(p.cost)}</td><td class="r">${money(p.value)}</td>
    <td class="r ${cls(p.unrealized)}">${money(p.unrealized)}</td><td class="r ${cls(p.realized)}">${money(p.realized)}</td></tr>`).join('');
  main.innerHTML = `
  <div class="card" data-open id="botnow"><h2>Mi bot ahora</h2><div id="botnow_b">${botNowHtml(bn)}</div></div>
  <div class="banner">El modo <b>papel</b> simula operaciones con precios reales y <b>no mueve dinero</b>. Los resultados simulados no garantizan resultados reales.</div>
  <div class="kpis">
    <div class="kpi"><div class="l">Bot</div><div class="v">${bot.cfg.enabled ? 'Activo' : 'Apagado'}</div><div class="s">${bot.cfg.symbol === 'AUTO' ? 'Cerebro AUTO' : esc(bot.cfg.strategy.toUpperCase()) + ' · ' + esc(bot.cfg.symbol)} · ${bot.cfg.mode === 'live' ? 'REAL' : 'papel'}</div></div>
    <div class="kpi"><div class="l">Exchanges conectados</div><div class="v">${conns.connections.length}</div><div class="s">solo llaves de trading</div></div>
    <div class="kpi"><div class="l">Posiciones</div><div class="v">${pnl.positions.length}</div><div class="s">según tus órdenes</div></div>
  </div>
  <div class="card"><h2>Resultado por posición</h2>
    ${rows ? `<div class="scroll"><table><thead><tr><th>Modo</th><th>Par</th><th class="r">Cantidad</th><th class="r">Costo</th><th class="r">Valor</th><th class="r">No realizado</th><th class="r">Realizado</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">Aún no hay órdenes. Configura tu bot en la pestaña Bot (empieza en modo papel).</p>'}
  </div>`;
  bindBotNow();
  let n = 0; let waiting = bn.enabled && !bn.last;
  tabTimer = setInterval(async () => {
    n++; if (!waiting && n % 8 !== 0) return; // rápido (4 s) mientras espera la primera decisión; luego cada ~30 s
    try { const b = await api('GET', '/api/bot/status'); const el = $('#botnow_b'); if (el) { el.innerHTML = botNowHtml(b); bindBotNow(); } waiting = b.enabled && !b.last; } catch { /* reintenta en el próximo ciclo */ }
  }, 4000);
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
  <div class="card"><h2>Avanzado: elegir yo la cripto y la estrategia</h2>
    <form id="bf" class="form">
      <label>Cripto (todas las listadas en Coinbase / Robinhood)<input name="symbol" list="symlist" value="${esc(cfg.symbol)}" autocomplete="off" autocapitalize="characters" spellcheck="false"><datalist id="symlist"><option value="AUTO">AUTO · el Cerebro elige</option>${(state.uni || state.me.symbols.map((s) => ({ s, cb: true, rh: null }))).map((x) => `<option value="${esc(x.s)}">${esc(x.s)}${x.cb ? ' · Coinbase' : ''}${x.rh ? ' · Robinhood' : ''}</option>`).join('')}</datalist><span class="muted" id="symhint" style="font-size:12px"></span></label>
      <label>Exchange (papel) / ruteo<select name="paperExchange">${opt('best', cfg.paperExchange, 'Mejor: el más barato por brecha de costo')}${opt('coinbase', cfg.paperExchange, 'Coinbase')}${opt('robinhood', cfg.paperExchange, 'Robinhood')}</select></label>
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
    const body = { symbol: f.symbol.value.trim().toUpperCase(), paperExchange: f.paperExchange.value, maxPositions: f.maxPositions.value, strategy: f.strategy.value, usd: f.usd.value, intervalMin: f.intervalMin.value, fast: f.fast.value,
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
  const [b, br] = await Promise.all([api('GET', '/api/owner/briefing'), api('GET', '/api/owner/brain')]);
  const icon = { crit: '●', warn: '●', info: '○' };
  const imp = b.items.filter((i) => i.level !== 'info'); const rest = b.items.filter((i) => i.level === 'info');
  const li = (i) => `<button class="item ${esc(i.level)}" data-go="${esc(i.tab)}"><span class="lv">${icon[i.level] || '○'}</span><span class="grow">${esc(i.text)}</span><span class="muted">›</span></button>`;
  const ap = br.guardrails.autopilot;
  const recent = br.changes.slice(0, 5).map((c) => `<div class="step-row"><div class="grow"><b>${esc(c.label || c.kind)}</b> ${c.auto ? '<span class="chip paper">auto</span>' : ''}<div class="muted" style="font-size:12px">${esc(ago(c.t))} · ${esc(c.title)}</div></div>${c.undone ? '<span class="muted">deshecho</span>' : `<button class="btn ghost small" data-undo="${esc(c.id)}">Deshacer</button>`}</div>`).join('');
  main.innerHTML = `
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
  document.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => { state.tab = x.dataset.go; if (!state.tab.startsWith('o_') && state.user.role === 'owner') state.showClient = true; shell(); loadTab(); }));
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
  const [m, sc] = await Promise.all([api('GET', '/api/market'), api('GET', '/api/scanner').catch(() => null)]);
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

async function tabSeguridad(main) {
  const [c, { events }] = await Promise.all([api('GET', '/api/owner/compliance'), api('GET', '/api/owner/audit')]);
  const row = (x) => `<div class="step-row ${x.ok ? 'ok' : ''}"><span class="dot">${x.ok ? '✓' : '○'}</span><div class="grow">${esc(x.label)}${x.detail ? `<div class="muted" style="font-size:12px">${esc(x.detail)}</div>` : ''}</div></div>`;
  const rows = events.map((e) => `<tr><td>${esc(ago(e.created_at))}</td><td>${esc(e.action)}</td><td>${esc(e.actor || '—')}</td><td>${esc(e.ip || '')}</td><td>${esc(e.detail || '')}</td></tr>`).join('');
  main.innerHTML = `
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
