// Interfaz de Quantum Trading. Sin librerías; todo dato dinámico pasa por esc() antes de insertarse.
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
      state.user = r.user; state.needTotp = false; state.tab = r.user.role === 'owner' ? 'o_overview' : 'resumen';
      await boot();
    } catch (err) {
      if (err.data && err.data.need_totp) { state.needTotp = true; viewAuth(); $('#m').textContent = err.message; $('#m').className = 'msg err'; return; }
      setMsg(m, err.message);
    }
  });
}

// ============================ Estructura ============================
const CLIENT_TABS = [['resumen', 'Resumen'], ['exchanges', 'Exchanges'], ['bot', 'Bot'], ['ordenes', 'Órdenes'], ['descargar', 'Bot descargable'], ['cuenta', 'Cuenta']];
const OWNER_TABS = [['o_overview', 'Analíticas'], ['o_clientes', 'Clientes'], ['o_cerebro', 'Cerebro'], ['o_export', 'Exportar'], ['o_seguridad', 'Seguridad'], ['o_ajustes', 'Ajustes']];

function shell() {
  const owner = state.user.role === 'owner';
  const tabs = (list) => list.map(([k, l]) => `<button data-t="${k}" class="${state.tab === k ? 'on' : ''}">${esc(l)}</button>`).join('');
  $('#root').innerHTML = `
  <div class="wrap">
    <div class="top">
      <div class="brand"><small>${owner ? 'Consola del dueño' : 'RDCMNATION'}</small>Quantum Trading</div>
      <div class="who"><span title="${esc(state.user.email)}">${esc(state.user.email)}</span><button class="btn ghost small" id="out">Salir</button></div>
    </div>
    <nav>${owner ? `${tabs(OWNER_TABS)}<span class="sep"></span>${tabs(CLIENT_TABS)}` : tabs(CLIENT_TABS)}</nav>
    <div id="main"></div>
    <p class="muted" style="font-size:12px">Quantum Trading es una herramienta de software. No es asesoría de inversión ni custodio de fondos. Operar cripto implica riesgo de perder todo el dinero. <a href="/legal.html" target="_blank" rel="noopener">Legal</a></p>
  </div>`;
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.t; shell(); loadTab(); }));
  $('#out').addEventListener('click', async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ya salió */ } state.user = null; state.me = null; render(); });
}

async function loadTab() {
  if (state.user.role === 'owner' && !state.user.totp && state.tab.startsWith('o_') && state.tab !== 'o_ajustes') { state.tab = 'o_ajustes'; shell(); }
  const main = $('#main');
  main.innerHTML = '<div class="card muted">Cargando…</div>';
  try {
    const fn = { resumen: tabResumen, exchanges: tabExchanges, bot: tabBot, ordenes: tabOrdenes, descargar: tabDescargar, cuenta: tabCuenta,
      o_cerebro: tabCerebro, o_export: tabExport, o_overview: tabOverview, o_clientes: tabClientes, o_seguridad: tabSeguridad, o_ajustes: tabAjustes }[state.tab];
    await fn(main);
  } catch (e) { main.innerHTML = `<div class="card"><span class="neg">${esc(e.message)}</span></div>`; }
}

// ============================ Cliente ============================
async function tabResumen(main) {
  const [pnl, bot, conns] = await Promise.all([api('GET', '/api/pnl'), api('GET', '/api/bot'), api('GET', '/api/connections')]);
  const rows = pnl.positions.map((p) => `<tr><td><span class="chip ${esc(p.mode)}">${p.mode === 'live' ? 'REAL' : 'PAPEL'}</span></td><td>${esc(p.symbol)}</td>
    <td class="r">${num(p.qty, 8)}</td><td class="r">${money(p.cost)}</td><td class="r">${money(p.value)}</td>
    <td class="r ${cls(p.unrealized)}">${money(p.unrealized)}</td><td class="r ${cls(p.realized)}">${money(p.realized)}</td></tr>`).join('');
  main.innerHTML = `
  <div class="banner">El modo <b>papel</b> simula operaciones con precios reales y <b>no mueve dinero</b>. Los resultados simulados no garantizan resultados reales.</div>
  <div class="kpis">
    <div class="kpi"><div class="l">Bot</div><div class="v">${bot.cfg.enabled ? 'Activo' : 'Apagado'}</div><div class="s">${esc(bot.cfg.strategy.toUpperCase())} · ${esc(bot.cfg.symbol)} · ${bot.cfg.mode === 'live' ? 'REAL' : 'papel'}</div></div>
    <div class="kpi"><div class="l">Exchanges conectados</div><div class="v">${conns.connections.length}</div><div class="s">solo llaves de trading</div></div>
    <div class="kpi"><div class="l">Posiciones</div><div class="v">${pnl.positions.length}</div><div class="s">según tus órdenes</div></div>
  </div>
  <div class="card"><h2>Resultado por posición</h2>
    ${rows ? `<div class="scroll"><table><thead><tr><th>Modo</th><th>Par</th><th class="r">Cantidad</th><th class="r">Costo</th><th class="r">Valor</th><th class="r">No realizado</th><th class="r">Realizado</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">Aún no hay órdenes. Configura tu bot en la pestaña Bot (empieza en modo papel).</p>'}
  </div>`;
}

const GUIDE = {
  coinbase: ['Entra a Coinbase Developer Platform → API Keys → Create API key.', 'Permisos: <b>View</b> y <b>Trade</b>. <b>NO</b> actives Transfer/retiros.', 'Copia el <b>API key name</b> (empieza con <code>organizations/</code>) y la <b>Private key</b> completa (PEM).'],
  robinhood: ['En Robinhood (web) → Cuenta → Configuración → Cripto → API Trading → crear credenciales.', 'Copia la <b>API key</b> y la <b>Private key</b> (base64).', 'La API de Robinhood Crypto no permite retiros.'],
};

async function tabExchanges(main) {
  const { connections } = await api('GET', '/api/connections');
  const rows = connections.map((c) => `<tr><td>${esc(c.exchange)}</td><td>${esc(c.label)}</td><td><code>${esc(String(c.key_id).slice(0, 18))}…</code></td>
    <td>${c.can_transfer ? '<span class="neg">retiros ON</span>' : '<span class="pos">solo trading</span>'}</td>
    <td class="r"><button class="btn ghost small" data-bal="${esc(c.id)}">Saldos</button> <button class="btn danger small" data-del="${esc(c.id)}">Quitar</button></td></tr>`).join('');
  main.innerHTML = `
  <div class="card"><h2>Tus conexiones</h2>
    ${rows ? `<div class="scroll"><table><thead><tr><th>Exchange</th><th>Nombre</th><th>Llave</th><th>Permisos</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Todavía no conectaste ningún exchange.</p>'}
    <div id="bal" class="msg"></div>
  </div>
  <div class="card"><h2>Conectar un exchange</h2>
    <form id="cf" class="form">
      <label>Exchange<select name="exchange"><option value="coinbase">Coinbase Advanced</option><option value="robinhood">Robinhood Crypto</option></select></label>
      <label>Nombre (opcional)<input name="label" maxlength="60" placeholder="Mi cuenta"></label>
      <label class="full">API key / key name<input name="keyId" required autocomplete="off"></label>
      <label class="full">Private key<textarea name="secret" required autocomplete="off" spellcheck="false"></textarea></label>
      <div class="full"><ol class="steps" id="guide"></ol></div>
      <div class="full banner">Tu llave se cifra (AES-256) antes de guardarse y solo se usa para operar tu cuenta. <b>Rechazamos llaves con permiso de retiro.</b> Nadie en Quantum Trading puede verla.</div>
      <button class="btn full" type="submit">Verificar y conectar</button><div class="msg full" id="cm"></div>
    </form>
  </div>`;
  const showGuide = () => { $('#guide').innerHTML = GUIDE[$('#cf [name=exchange]').value].map((x) => `<li>${x}</li>`).join(''); };
  $('#cf [name=exchange]').addEventListener('change', showGuide); showGuide();
  $('#cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    setMsg($('#cm'), 'Verificando con el exchange…', true);
    try { await api('POST', '/api/connections', f); e.target.reset(); await loadTab(); } catch (err) { setMsg($('#cm'), err.message); }
  });
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
  const live = state.me.liveTradingEnabled;
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label || v)}</option>`;
  main.innerHTML = `
  <div class="card"><h2>Tu bot</h2>
    <form id="bf" class="form">
      <label>Par<select name="symbol">${state.me.symbols.map((s) => opt(s, cfg.symbol)).join('')}</select></label>
      <label>Estrategia<select name="strategy">${opt('dca', cfg.strategy, 'DCA: compra periódica')}${opt('sma', cfg.strategy, 'SMA: cruce de medias (1 h)')}${opt('rsi', cfg.strategy, 'RSI: sobreventa / sobrecompra (1 h)')}${opt('macd', cfg.strategy, 'MACD: cruce de momentum (1 h)')}</select></label>
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
    <p class="muted" style="font-size:13px">Simula tu configuración sobre las últimas ~300 velas de 1 hora (unos 12 días) con comisión de 0.6 % por operación y la compara con comprar y mantener. Sirve para descartar estrategias malas; <b>no predice el futuro</b>.</p>
    <div class="row"><button class="btn ghost" id="bt_run" type="button">Correr backtest</button></div>
    <div id="bt_out" class="scroll"></div><div class="msg" id="bt_m"></div>
  </div>`;
  const sync = () => {
    const f = $('#bf');
    document.querySelectorAll('.dca').forEach((n) => { n.style.display = f.strategy.value === 'dca' ? '' : 'none'; });
    document.querySelectorAll('.sma').forEach((n) => { n.style.display = f.strategy.value === 'sma' ? '' : 'none'; });
    document.querySelectorAll('.rsi').forEach((n) => { n.style.display = f.strategy.value === 'rsi' ? '' : 'none'; });
    document.querySelectorAll('.nodca').forEach((n) => { n.style.display = f.strategy.value === 'dca' ? 'none' : ''; });
    document.querySelectorAll('.real').forEach((n) => { n.style.display = f.mode.value === 'live' ? '' : 'none'; });
  };
  $('#bf').addEventListener('change', sync); sync();
  $('#bf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { symbol: f.symbol.value, strategy: f.strategy.value, usd: f.usd.value, intervalMin: f.intervalMin.value, fast: f.fast.value,
      slow: f.slow.value, rsiBuy: f.rsiBuy.value, rsiSell: f.rsiSell.value, stopLossPct: f.stopLossPct.value, mode: f.mode.value, connectionId: f.connectionId.value || null, maxOrderUsd: f.maxOrderUsd.value,
      maxDailyUsd: f.maxDailyUsd.value, liveAck: f.liveAck.checked, enabled: f.enabled.checked };
    try { await api('PUT', '/api/bot', body); setMsg($('#bm'), 'Guardado.', true); } catch (err) { setMsg($('#bm'), err.message); }
  });
  $('#sg_run').addEventListener('click', async () => {
    const sym = $('#bf').symbol.value;
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
      const r = await api('POST', '/api/backtest', { symbol: f.symbol.value, strategy: f.strategy.value, usd: f.usd.value,
        intervalMin: f.intervalMin.value, fast: f.fast.value, slow: f.slow.value, rsiBuy: f.rsiBuy.value, rsiSell: f.rsiSell.value, stopLossPct: f.stopLossPct.value, maxOrderUsd: f.maxOrderUsd.value, maxDailyUsd: f.maxDailyUsd.value });
      const m = r.metrics;
      const pct = (x) => (x === null ? '—' : `${x.toFixed(2)} %`);
      const n2 = (x) => (x === null ? '—' : x.toFixed(2));
      setMsg($('#bt_m'), '');
      $('#bt_out').innerHTML = `<table><tbody>
        <tr><td>Retorno de la estrategia</td><td class="r ${cls(m.totalReturnPct)}">${pct(m.totalReturnPct)}</td></tr>
        <tr><td>Comprar y mantener</td><td class="r ${cls(m.buyHoldPct)}">${pct(m.buyHoldPct)}</td></tr>
        <tr><td>Caída máxima (max drawdown)</td><td class="r neg">${pct(m.maxDrawdownPct)}</td></tr>
        <tr><td>Sharpe / Sortino (anualizados)</td><td class="r">${n2(m.sharpe)} / ${n2(m.sortino)}</td></tr>
        <tr><td>Compras / operaciones cerradas</td><td class="r">${m.buys} / ${m.closedTrades}</td></tr>
        <tr><td>Beta / alfa anual vs. el activo</td><td class="r">${n2(m.beta)} / ${pct(m.alphaAnnualPct)}</td></tr>
        <tr><td>Tiempo en posición</td><td class="r">${pct(m.exposurePct)}</td></tr>
        <tr><td>% ganadoras / factor de beneficio</td><td class="r">${pct(m.winRatePct)} / ${n2(m.profitFactor)}</td></tr></tbody></table>
        <p class="muted" style="font-size:12px">Capital de referencia ${money(r.capital, 0)}, ${r.candles} velas, comisión ${r.feePct} %.</p>`;
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

const KIND_LABEL = { strategy_defaults: 'Estrategia sugerida', agent_toggle: 'Activar/desactivar agente', model_update: 'Actualizar modelo ML',
  risk_alert: 'Alerta de riesgo', ops_alert: 'Alerta operativa', insight: 'Hallazgo' };
const APPLIES = ['strategy_defaults', 'agent_toggle', 'model_update'];

async function tabCerebro(main) {
  const b = await api('GET', '/api/owner/brain');
  const agents = b.agents.map((a) => `<tr><td><b>${esc(a.label)}</b><div class="muted" style="font-size:12px;white-space:normal">${esc(a.description)}${a.available ? '' : ` · No disponible: ${esc(a.reason || '')}`}</div></td>
    <td>${a.available ? (a.enabled ? '<span class="pos">activo</span>' : 'apagado') : '<span class="muted">no disponible</span>'}</td>
    <td class="r">${a.available ? `<button class="btn ghost small" data-ag="${esc(a.name)}" data-en="${a.enabled ? '0' : '1'}">${a.enabled ? 'Apagar' : 'Encender'}</button>` : ''}</td></tr>`).join('');
  const pend = b.pending.map((p) => `<div class="card" style="margin-top:10px"><div class="row"><span class="chip">${esc(KIND_LABEL[p.kind] || p.kind)}</span><span class="chip">${esc(p.agent || '')}</span></div>
    <h3 style="margin-top:8px">${esc(p.title)}</h3>
    <p class="muted" style="font-size:13px">${esc((p.detail && p.detail.text) || '')}</p>
    <details><summary class="muted" style="font-size:12px;cursor:pointer">Evidencia</summary><pre style="white-space:pre-wrap;font-size:11px;overflow-x:auto">${esc(JSON.stringify(p.evidence, null, 1))}</pre></details>
    <div class="row" style="margin-top:8px">${APPLIES.includes(p.kind) ? `<button class="btn small" data-dec="approve" data-id="${esc(p.id)}">Aprobar y aplicar</button>` : `<button class="btn ghost small" data-dec="approve" data-id="${esc(p.id)}">Enterado</button>`}
    <button class="btn ghost small" data-dec="reject" data-id="${esc(p.id)}">Rechazar</button></div></div>`).join('');
  const hist = b.history.map((p) => `<tr><td>${esc(when(p.decided_at || p.created_at))}</td><td>${esc(KIND_LABEL[p.kind] || p.kind)}</td><td style="white-space:normal">${esc(p.title)}</td><td>${esc(p.status)}</td></tr>`).join('');
  const models = b.models.map((m) => `<tr><td>${esc(m.symbol)}</td><td>${m.active ? '<span class="pos">activo</span>' : 'ninguno'}</td>
    <td>${m.candidate ? `precisión ${(m.candidate.metrics.acc_test * 100).toFixed(1)} % vs ${(m.candidate.metrics.baseline_test * 100).toFixed(1)} % base (z=${Number(m.candidate.metrics.z_test).toFixed(1)})` : '—'}</td>
    <td>${m.candidate && m.candidate.drift ? `deriva ${Number(m.candidate.drift.score).toFixed(1)}` : '—'}</td></tr>`).join('');
  const g = b.guardrails;
  main.innerHTML = `
  <div class="banner">El Cerebro solo <b>propone</b>. Nada cambia sin tu aprobación, y las áreas protegidas (riesgo, aislamiento de datos, seguridad, acceso del dueño) nunca las toca un agente.</div>
  <div class="kpis">
    <div class="kpi"><div class="l">Versión del app</div><div class="v">${esc(b.app_version)}</div></div>
    <div class="kpi"><div class="l">Versión del Cerebro</div><div class="v">${b.brain_version}</div></div>
    <div class="kpi"><div class="l">Pendientes</div><div class="v">${b.pending.length}</div></div>
    <div class="kpi"><div class="l">Última corrida</div><div class="s">${esc(when(b.last_run))}</div></div>
  </div>
  <div class="card"><h2>Director</h2><div class="row"><button class="btn" id="br_run">Correr análisis ahora</button></div><div class="msg" id="br_m"></div></div>
  <div class="card"><h2>Propuestas pendientes</h2>${pend || '<p class="muted">Nada pendiente.</p>'}<div class="msg" id="pr_m"></div></div>
  <div class="card"><h2>Agentes</h2><div class="scroll"><table><tbody>${agents}</tbody></table></div><div class="msg" id="ag_m"></div></div>
  <div class="card"><h2>Modelos ML</h2><div class="scroll"><table><thead><tr><th>Par</th><th>Estado</th><th>Último entrenamiento (fuera de muestra)</th><th>Deriva</th></tr></thead><tbody>${models}</tbody></table></div>
    <p class="muted" style="font-size:12px">Un modelo solo se propone si supera la línea base con significancia estadística (z &gt; 2). Si no, el sistema te lo dice.</p></div>
  <div class="card"><h2>Límites inviolables</h2>
    <form id="gf" class="form">
      <label>Máx. propuestas pendientes<input name="maxPendingProposals" type="number" min="1" max="100" value="${esc(g.maxPendingProposals)}"></label>
      <label>Corrida automática cada (horas)<input name="autoRunHours" type="number" min="1" max="168" value="${esc(g.autoRunHours)}"></label>
      <label class="full">Tipos de propuesta permitidos<span class="row">${Object.keys(KIND_LABEL).map((k) => `<label class="check"><input type="checkbox" name="kind_${k}" ${g.allowedKinds.includes(k) ? 'checked' : ''}><span>${esc(KIND_LABEL[k])}</span></label>`).join('')}</span></label>
      <p class="muted full" style="font-size:12px">Áreas protegidas (fijas): ${g.protectedAreas.map((a) => `<code>${esc(a)}</code>`).join(' ')}</p>
      <button class="btn full" type="submit">Guardar límites</button><div class="msg full" id="gm"></div>
    </form></div>
  <div class="card"><h2>Historial</h2>${hist ? `<div class="scroll"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Propuesta</th><th>Estado</th></tr></thead><tbody>${hist}</tbody></table></div>` : '<p class="muted">Sin historial.</p>'}</div>`;
  $('#br_run').addEventListener('click', async (e) => {
    e.target.disabled = true; setMsg($('#br_m'), 'Analizando datos reales… puede tardar unos segundos.', true);
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
    try { await api('PUT', '/api/owner/guardrails', { maxPendingProposals: f.maxPendingProposals.value, autoRunHours: f.autoRunHours.value, allowedKinds }); setMsg($('#gm'), 'Límites guardados.', true); }
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
  const { events } = await api('GET', '/api/owner/audit');
  const rows = events.map((e) => `<tr><td>${esc(when(e.created_at))}</td><td>${esc(e.action)}</td><td>${esc(e.actor || '—')}</td><td>${esc(e.ip || '')}</td><td>${esc(e.detail || '')}</td></tr>`).join('');
  main.innerHTML = `<div class="card"><h2>Registro de auditoría (últimos ${events.length})</h2><div class="scroll"><table><thead><tr><th>Fecha</th><th>Acción</th><th>Usuario</th><th>IP</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

async function tabAjustes(main) {
  let s = null;
  try { s = await api('GET', '/api/owner/settings'); } catch (e) { if (!(e.data && e.data.need_2fa_setup)) throw e; }
  main.innerHTML = `
  ${s ? '' : '<div class="banner">Por seguridad, activa la verificación en dos pasos (2FA) para usar la consola del dueño.</div>'}
  ${s ? `<div class="card"><h2>Plataforma</h2>
    <label class="check"><input type="checkbox" id="s_live" ${s.live_trading ? 'checked' : ''}><span><b>Permitir trading REAL a los clientes.</b> Si lo apagas, todos los bots en modo real se detienen. Actívalo solo después de probar con tu propia cuenta y revisar los documentos legales con un abogado.</span></label>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="s_reg" ${s.registration_open ? 'checked' : ''}><span><b>Registro abierto</b> (nuevos clientes pueden crear cuenta).</span></label>
    <div class="row" style="margin-top:12px"><button class="btn" id="s_save">Guardar</button></div><div class="msg" id="sm"></div>
  </div>` : ''}
  <div class="card"><h2>Verificación en dos pasos (2FA) para tu cuenta de dueño</h2>
    <p class="muted" style="font-size:13px">Estado: ${state.user.totp ? '<b class="pos">activada</b>' : '<b class="neg">desactivada</b>'}. Recomendado: actívala. Usa Google Authenticator, Authy o 1Password.</p>
    <div class="row"><button class="btn ghost" id="t_setup">${state.user.totp ? 'Cambiar 2FA' : 'Activar 2FA'}</button></div>
    <div id="t_box"></div>
  </div>`;
  if (s) $('#s_save').addEventListener('click', async () => {
    try { await api('PUT', '/api/owner/settings', { live_trading: $('#s_live').checked, registration_open: $('#s_reg').checked }); setMsg($('#sm'), 'Guardado.', true); state.me = await api('GET', '/api/me'); } catch (err) { setMsg($('#sm'), err.message); }
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
