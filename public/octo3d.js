// Pulpo 3D sobre un mapa de criptos. Motor 3D propio en canvas 2D (proyección en perspectiva, orden por profundidad):
import { tr } from '/i18n.js';
// sin librerías ni WebGL, así funciona en cualquier teléfono y respeta la política de seguridad (solo scripts propios).
// Todo lo que muestra sale de datos reales del bot: cada isla es una cripto, su altura es la fuerza de la señal y
// el pulpo va evaluando una por una; cuando el bot compra o suelta, el pulpo va a esa isla y lo ejecuta a la vista.
const TAU = Math.PI * 2;
const STYLE = 'ufo'; // 'toy' = juguete articulado amarillo limón; 'real' = pulpo realista
const COLORS = { held: '#4ade80', ok: '#ffd60a', idle: '#8a8776', off: '#4a4a44', hot: '#ff5d4d', buy: '#4ade80', keep: '#ffd60a', drop: '#ff5d4d' };
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (h, a) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; };
const shade = (h, k) => { const [r, g, b] = hexRgb(h); const f = (v) => Math.max(0, Math.min(255, Math.round(v * k))); return `rgb(${f(r)},${f(g)},${f(b)})`; };

// Motas de la piel del manto, fijas (generadas con una semilla para que no parpadeen).
const ARM_LEN = [1, 0.92, 1.1, 0.88, 1.04, 0.95, 1.12, 0.9];
const BLOTCH = (() => { let x = 777; const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; return Array.from({ length: 16 }, () => ({ x: (rnd() - 0.5) * 1.6, y: (rnd() - 0.5) * 1.6, r: 0.25 + rnd() * 0.35, dark: rnd() > 0.45 })); })();
const SPECKS = (() => { let x = 12345; const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; const a = []; for (let i = 0; i < 130; i++) { const r = Math.sqrt(rnd()) * 0.95; const t = rnd() * TAU; a.push({ x: Math.cos(t) * r * 0.9, y: Math.sin(t) * r, r: 0.012 + rnd() * 0.04, a: 0.1 + rnd() * 0.3, dark: rnd() > 0.35 }); } return a; })();

export function createOcto3D(cv, d0, opt = {}) {
  const say = (t, hi) => { try { if (opt.onSay && t) opt.onSay(t, hi); } catch { /* sin voz */ } };
  const ctx = cv.getContext('2d'); { const _ft = ctx.fillText.bind(ctx); const _mt = ctx.measureText.bind(ctx); ctx.fillText = (t, ...r) => _ft(tr(String(t)), ...r); ctx.measureText = (t) => _mt(tr(String(t))); } const dpr = Math.min(2, window.devicePixelRatio || 1);
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let d = d0; let W = 340; const H = 340;
  const isl = new Map(); // islas (criptos)
  const parts = []; const floaters = []; const rings = [];
  const events = []; // acciones pendientes: { label, type: 'buy' | 'sell' }
  const prev = new Map();
  const oct = { x: 0, z: 0, vx: 0, vz: 0, heading: 0, target: null, mode: 'tour', until: 0, reach: 0, bob: 0, tint: 0 };
  const bubbles = Array.from({ length: 34 }, () => ({ x: (Math.random() - 0.5) * 9, z: (Math.random() - 0.5) * 9, y: Math.random() * 6, v: 0.25 + Math.random() * 0.5, r: 0.04 + Math.random() * 0.09, ph: Math.random() * TAU }));
  const cam = { az: 0.6, el: 0.78, D: 15, fx: 0, fz: 0 };
  let hud = { title: 'Mapa de criptos', sub: 'esperando datos' }; let tourIdx = 0; let last = performance.now(); let alive = true;

  const size = () => { W = cv.clientWidth || 340; cv.style.height = `${H}px`; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  // Proyección: gira el mundo alrededor del foco, inclina la cámara y aplica perspectiva.
  const proj = (x, y, z) => {
    const dx = x - cam.fx; const dz = z - cam.fz; const dy = y - 0.6;
    const ca = Math.cos(cam.az); const sa = Math.sin(cam.az); const x1 = dx * ca - dz * sa; const z1 = dx * sa + dz * ca;
    const ce = Math.cos(cam.el); const se = Math.sin(cam.el); const y2 = dy * ce + z1 * se; const z2 = -dy * se + z1 * ce + cam.D;
    const k = (W * 1.34) / Math.max(1.5, z2);
    return { x: W / 2 + x1 * k, y: H * 0.56 - y2 * k, k, z: z2 };
  };

  // Reparto de islas: las más fuertes en el anillo interior, las demás afuera; se deslizan al cambiar el orden.
  const layout = (nd) => {
    const sorted = nd.nodes.map((n, i) => ({ ...n, i })).sort((a, b) => (b.w || 0) - (a.w || 0) || a.i - b.i);
    const seen = new Set(); const inner = Math.min(6, sorted.length); const outer = Math.max(0, sorted.length - inner);
    sorted.forEach((n, i) => {
      const ring = i < inner ? 0 : 1; const idx = ring ? i - inner : i; const cnt = ring ? outer : inner;
      const ang = (idx / Math.max(1, cnt)) * TAU + (ring ? 0.4 : -1.2); const r = ring ? 10.2 : 5.4;
      const tx = Math.cos(ang) * r; const tz = Math.sin(ang) * r; seen.add(n.label);
      const row = (nd.rows || []).find((x) => x.sym === n.label);
      const cur = isl.get(n.label);
      const fields = { kind: n.kind, sub: n.sub || '', tw: Math.max(0.05, n.w || 0), tx, tz, row, gone: false };
      if (cur) Object.assign(cur, fields);
      else isl.set(n.label, { label: n.label, x: tx, z: tz, w: 0, al: 0, ph: Math.random() * TAU, ...fields });
    });
    for (const [k, n] of isl) if (!seen.has(k)) n.gone = true;
    // detecta compras y ventas nuevas para que el pulpo las ejecute a la vista
    for (const n of isl.values()) {
      const st = (n.sub || '').split(' ')[0]; const before = prev.get(n.label);
      if (before !== undefined && before !== st) { if (st === 'compró') events.push({ label: n.label, type: 'buy' }); else if (['suelta', 'vendió', 'soltó'].includes(st)) events.push({ label: n.label, type: 'sell' }); }
      prev.set(n.label, st);
    }
  };

  const burst = (x, y, z, col, n = 26) => { for (let i = 0; i < n; i++) { const a = Math.random() * TAU; const s = 0.04 + Math.random() * 0.1; parts.push({ x, y, z, vx: Math.cos(a) * s, vy: 0.05 + Math.random() * 0.12, vz: Math.sin(a) * s, life: 1, col }); } };

  const pickTarget = (t) => {
    const ev = events.shift();
    if (ev && isl.has(ev.label)) { oct.target = isl.get(ev.label); oct.mode = ev.type; oct.until = t + 2800; say(`Voy a ${ev.type === 'buy' ? 'comprar' : 'soltar'} ${ev.label}.`, true); return; }
    const list = [...isl.values()].filter((n) => !n.gone).sort((a, b) => b.tw - a.tw);
    if (!list.length) { oct.target = null; oct.until = t + 1500; return; }
    tourIdx = (tourIdx + 1) % list.length; oct.target = list[tourIdx]; oct.mode = 'tour'; oct.until = t + 2400;
    rings.push({ x: oct.target.x, z: oct.target.z, r: 0.5, col: COLORS[oct.target.kind] || COLORS.idle });
    const n = oct.target; const row = n.row;
    hud = { title: `Evaluando ${n.label}`, sub: row ? `${row.state}${row.score ? ` · puntaje ${row.score.toFixed(1)}` : ''}${row.note ? ` · ${row.note}` : ''}` : (n.sub || 'vigilando') };
    say(`Escaneando ${n.label}. ${row && row.why ? row.why : (n.sub || 'sin cambios')}`, false);
  };

  const ops = []; // todo lo que se dibuja con profundidad (esferas, partes del pulpo)
  const sphere = (x, y, z, r, col, a = 1, soft = false) => { const p = proj(x, y, z); const sp = { p, r: r * p.k, col, a, z: p.z, soft }; ops.push({ z: p.z, d: () => drawSphere(sp) }); };

  const drawSphere = (s) => {
    const { p, r, col, a, soft } = s; if (r < 0.4) return;
    const g = ctx.createRadialGradient(p.x - r * 0.38, p.y - r * 0.42, r * 0.08, p.x, p.y, r);
    g.addColorStop(0, shade(col, soft ? 1.25 : 1.55)); g.addColorStop(0.5, shade(col, 1)); g.addColorStop(1, shade(col, soft ? 0.7 : 0.42));
    ctx.globalAlpha = a; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
  };

  const groundCircle = (x, z, r, fill, stroke, lw = 1) => {
    ctx.beginPath(); for (let i = 0; i <= 24; i++) { const a = (i / 24) * TAU; const p = proj(x + Math.cos(a) * r, 0, z + Math.sin(a) * r); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
    if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  };

  const pill = (text, x, y, col, bold) => {
    ctx.font = `${bold ? 700 : 600} 11px ui-monospace,Menlo,monospace`; const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(8,8,11,.78)'; ctx.strokeStyle = rgba(col, 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 10, w, 18, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.fillText(text, x, y + 3);
  };

  const frame = (now) => {
    if (!alive || !document.body.contains(cv)) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; const t = now;
    const sec = now / 1000;
    // islas: animar hacia su objetivo
    for (const [k, n] of isl) { n.x += (n.tx - n.x) * 0.05; n.z += (n.tz - n.z) * 0.05; n.w += (n.tw - n.w) * 0.06; n.al += ((n.gone ? 0 : 1) - n.al) * 0.08; if (n.gone && n.al < 0.03) { isl.delete(k); prev.delete(k); if (oct.target === n) oct.until = 0; } }
    // planificador del pulpo
    if (!oct.target || t > oct.until) pickTarget(t);
    const tg = oct.target;
    const speedK = oct.mode === 'tour' ? 0.9 : 1.6;
    if (tg) {
      const ox = tg.x - oct.x; const oz = tg.z - oct.z; const dist = Math.hypot(ox, oz);
      const want = dist > 1.3 ? 1 : 0; const sp = Math.min(dist, 3.2 * speedK);
      oct.vx += ((ox / (dist || 1)) * sp * want - oct.vx) * 0.04; oct.vz += ((oz / (dist || 1)) * sp * want - oct.vz) * 0.04;
      if (dist <= 1.8 && (oct.mode === 'buy' || oct.mode === 'sell') && !oct.did) { oct.did = true; const col = oct.mode === 'buy' ? '#4ade80' : '#ff5d4d'; burst(tg.x, 1.2, tg.z, col, 38); rings.push({ x: tg.x, z: tg.z, r: 0.5, col }); floaters.push({ x: tg.x, y: 3.4, z: tg.z, text: oct.mode === 'buy' ? `COMPRA ${tg.label}` : `SUELTA ${tg.label}`, col, life: 1 }); hud = { title: `${oct.mode === 'buy' ? 'Comprando' : 'Soltando'} ${tg.label}`, sub: tg.row ? `${tg.row.state}${tg.row.note ? ` · ${tg.row.note}` : ''}` : tg.sub }; say(tg.row && tg.row.why ? tg.row.why : `${oct.mode === 'buy' ? 'Comprando' : 'Soltando'} ${tg.label}.`, true); }
      if (oct.mode === 'tour') oct.did = false; if (t > oct.until - 100) oct.did = false;
      oct.reach += (((oct.mode !== 'tour' && dist < 3) || (oct.mode === 'tour' && dist < 2.2)) ? 1 - oct.reach : -oct.reach) * 0.06;
    } else { oct.vx *= 0.95; oct.vz *= 0.95; oct.reach *= 0.9; }
    oct.x += oct.vx * dt; oct.z += oct.vz * dt; oct.bob += dt;
    const spd = Math.hypot(oct.vx, oct.vz); if (spd > 0.15) { let da = Math.atan2(oct.vz, oct.vx) - oct.heading; da = Math.atan2(Math.sin(da), Math.cos(da)); oct.heading += da * 0.08; }
    // cámara: orbita despacio y sigue al pulpo
    cam.az += dt * 0.12; cam.fx += (oct.x * 0.6 - cam.fx) * 0.03; cam.fz += (oct.z * 0.6 - cam.fz) * 0.03; cam.el = 0.74 + Math.sin(sec / 7) * 0.05;

    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#050507'); bg.addColorStop(0.5, '#0c0b06'); bg.addColorStop(1, '#14120a'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // cuadrícula del mapa
    ctx.lineWidth = 1;
    for (let i = -18; i <= 18; i += 2) {
      for (const [ax, az, bx, bz] of [[i, -18, i, 18], [-18, i, 18, i]]) {
        const a = proj(ax, 0, az); const b = proj(bx, 0, bz); const fade = Math.max(0, Math.min(1, 1.1 - ((a.z + b.z) / 2 - 8) / 22));
        ctx.strokeStyle = `rgba(255,214,10,${0.05 + 0.1 * fade * (i % 6 === 0 ? 1.6 : 1)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // rutas del mapa entre islas cercanas
    const list = [...isl.values()]; ctx.setLineDash([4, 6]); ctx.lineWidth = 1;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = list[i]; const B = list[j]; const dd = Math.hypot(A.x - B.x, A.z - B.z); if (dd > 7.2) continue;
      const a = proj(A.x, 0, A.z); const b = proj(B.x, 0, B.z); ctx.strokeStyle = `rgba(255,214,10,${0.16 * Math.min(A.al, B.al)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // islas (de lejos a cerca)
    const labels = []; ops.length = 0;
    list.sort((a, b) => proj(b.x, 0, b.z).z - proj(a.x, 0, a.z).z);
    for (const n of list) {
      const col = COLORS[n.kind] || COLORS.idle; const pr = proj(n.x, 0, n.z); const h = 0.5 + n.w * 3.4; const pulse = 0.5 + 0.5 * Math.sin(sec * 2 + n.ph);
      ctx.globalAlpha = n.al;
      groundCircle(n.x, n.z, 1.5, rgba(col, 0.1 + 0.08 * pulse), rgba(col, 0.55), 1.4); groundCircle(n.x, n.z, 0.9, rgba(col, 0.22), null);
      const top = proj(n.x, h, n.z); const bw = Math.max(2, 0.34 * pr.k);
      const gr = ctx.createLinearGradient(0, top.y, 0, pr.y); gr.addColorStop(0, rgba(col, 0.95)); gr.addColorStop(1, rgba(col, 0.15));
      ctx.fillStyle = gr; ctx.fillRect(pr.x - bw / 2, top.y, bw, pr.y - top.y);
      ctx.globalAlpha = 1;
      sphere(n.x, h + 0.25, n.z, 0.38 + 0.1 * pulse, col, n.al);
      labels.push({ n, top, col });
    }
    for (const r of rings) { r.r += dt * 4; const a = Math.max(0, 1 - r.r / 5); if (a <= 0) r.dead = true; else groundCircle(r.x, r.z, r.r, null, rgba(r.col, a * 0.8), 2); }
    for (let i = rings.length - 1; i >= 0; i--) if (rings[i].dead) rings.splice(i, 1);
    // red dorada: la nave atrapa todo el mapa (hilos hacia cada cripto, anillo que las une y cúpula de malla)
    if (STYLE === 'ufo' && isl.size) {
      const alt2 = 2.7 + Math.sin(oct.bob * 1.8) * 0.16; const uc = proj(oct.x, alt2, oct.z); const list = [...isl.values()].filter((n) => n.al > 0.2).map((n) => ({ n, p: proj(n.x, 0.15, n.z), ang: Math.atan2(n.z, n.x) })).sort((a, b) => a.ang - b.ang);
      ops.push({ z: 99, d: () => {
        ctx.save(); ctx.lineCap = 'round';
        list.forEach((e, i) => { const nx = list[(i + 1) % list.length]; const pulse = 0.5 + 0.5 * Math.sin(sec * 2 + i);
          ctx.strokeStyle = `rgba(255,214,10,${0.1 + 0.1 * pulse})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(uc.x, uc.y); ctx.quadraticCurveTo((uc.x + e.p.x) / 2, Math.min(uc.y, e.p.y) - 18, e.p.x, e.p.y - 6); ctx.stroke();
          ctx.strokeStyle = 'rgba(255,214,10,.16)'; ctx.beginPath(); ctx.moveTo(e.p.x, e.p.y); ctx.lineTo(nx.p.x, nx.p.y); ctx.stroke();
          const u = ((sec * 0.5 + i / list.length) % 1); const px = uc.x + (e.p.x - uc.x) * u; const py = uc.y + (e.p.y - 6 - uc.y) * u - Math.sin(u * Math.PI) * 14;
          ctx.fillStyle = 'rgba(255,241,168,.95)'; ctx.beginPath(); ctx.arc(px, py, 1.7, 0, TAU); ctx.fill(); });
        ctx.restore(); } });
    }
    // naves exploradoras: cada una trabaja para el cerebro (noticias, mercado, movimientos, riesgo, costos) y le manda datos
    if (STYLE === 'ufo' && d.scouts && d.scouts.length) {
      const alt2 = 2.7 + Math.sin(oct.bob * 1.8) * 0.16; const uc = proj(oct.x, alt2, oct.z); const N = d.scouts.length;
      d.scouts.forEach((sc, i) => {
        const a = sec * 0.22 + (i / N) * TAU; const dep = Math.sin(a); const p = { x: W / 2 + Math.cos(a) * W * 0.36, y: H * 0.1 + (dep + 1) * H * 0.05 + Math.sin(sec * 1.4 + i) * 3, k: 30 + dep * 6, z: 4 - dep }; const sh = { x: p.x, y: p.y + H * 0.45 };
        ops.push({ z: p.z - 0.2, d: () => {
          const col = sc.col || '#5ac8fa'; const R = Math.max(5, p.k * 0.34);
          ctx.save();
          ctx.strokeStyle = `${col}55`; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.lineDashOffset = -sec * 18; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(uc.x, uc.y); ctx.stroke(); ctx.setLineDash([]);
          for (let k = 0; k < 3; k++) { const u = (sec * 0.8 + k / 3 + i * 0.17) % 1; ctx.fillStyle = col; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(p.x + (uc.x - p.x) * u, p.y + (uc.y - p.y) * u, 1.8, 0, TAU); ctx.fill(); }
          ctx.globalAlpha = 0.18; ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(sh.x, sh.y, R * 1.2, R * 0.4, 0, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
          const g = ctx.createRadialGradient(p.x, p.y - R * 0.2, 1, p.x, p.y, R * 1.6); g.addColorStop(0, '#f4f6fa'); g.addColorStop(0.6, '#8a93a6'); g.addColorStop(1, '#3a4152');
          ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(p.x, p.y, R * 1.5, R * 0.52, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = `${col}cc`; ctx.beginPath(); ctx.ellipse(p.x, p.y - R * 0.28, R * 0.7, R * 0.5, 0, Math.PI, TAU); ctx.fill();
          ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.fillStyle = col; for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.arc(p.x + k * R * 0.7, p.y + R * 0.1, Math.max(1, R * 0.12), 0, TAU); ctx.fill(); } ctx.shadowBlur = 0;
          ctx.restore();
          ctx.font = '700 8px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.fillStyle = col; ctx.fillText(sc.name, p.x, p.y - R * 1.1 - 3);
          ctx.font = '600 8px ui-monospace,Menlo,monospace'; ctx.fillStyle = 'rgba(230,230,220,.85)'; ctx.fillText(String(sc.val || '').slice(0, 22), p.x, p.y + R * 1.25 + 7);
        } });
      });
    }
    // sombra del pulpo
    groundCircle(oct.x, oct.z, 1.2, 'rgba(0,0,0,.35)', null);
    if (STYLE === 'ufo') {
      // OVNI con IA: vuela sobre el mapa, escanea la cripto que evalúa y lanza un rayo verde al comprar o rojo al soltar
      const alt = 2.7 + Math.sin(oct.bob * 1.8) * 0.16; const c = proj(oct.x, alt, oct.z); const R = c.k * 0.95;
      const fwd = proj(oct.x + oct.vx * 0.4, alt, oct.z + oct.vz * 0.4); const tilt = Math.max(-0.28, Math.min(0.28, (fwd.x - c.x) * 0.02));
      const acting = (oct.mode === 'buy' || oct.mode === 'sell') && tg; const beamCol = oct.mode === 'sell' ? [255, 93, 77] : [74, 222, 128];
      const ground = proj(oct.x, 0, oct.z);
      ops.push({ z: c.z + 0.4, d: () => {
        // rayo hacia abajo (compra/venta) o haz de escaneo hacia la cripto evaluada
        if (acting && oct.reach > 0.2) {
          const a = Math.min(1, oct.reach) * (0.55 + 0.15 * Math.sin(sec * 14)); const w0 = R * 0.5; const w1 = R * 1.5;
          const g = ctx.createLinearGradient(0, c.y, 0, ground.y); g.addColorStop(0, `rgba(${beamCol},${a})`); g.addColorStop(1, `rgba(${beamCol},${a * 0.15})`);
          ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(c.x - w0, c.y + R * 0.3); ctx.lineTo(c.x + w0, c.y + R * 0.3); ctx.lineTo(ground.x + w1, ground.y); ctx.lineTo(ground.x - w1, ground.y); ctx.closePath(); ctx.fill();
          for (let i = 0; i < 6; i++) { const u = ((sec * (oct.mode === 'sell' ? -0.9 : 0.9) + i / 6) % 1 + 1) % 1; const yy = c.y + (ground.y - c.y) * u; const xx = c.x + (ground.x - c.x) * u; ctx.fillStyle = `rgba(${beamCol},${0.8 * (1 - u)})`; ctx.beginPath(); ctx.arc(xx + Math.sin(sec * 5 + i * 2) * R * 0.5 * (0.4 + u), yy, Math.max(1, R * 0.05), 0, TAU); ctx.fill(); }
        } else if (tg && oct.reach > 0.15) {
          const tp = proj(tg.x, 0.5, tg.z); const a = 0.3 * Math.min(1, oct.reach * 1.5); const dx = tp.x - c.x; const dy = tp.y - c.y; const L = Math.hypot(dx, dy) || 1; const nx = -dy / L; const ny = dx / L; const w1 = R * 0.7;
          const g = ctx.createLinearGradient(c.x, c.y, tp.x, tp.y); g.addColorStop(0, `rgba(255,214,10,${a})`); g.addColorStop(1, `rgba(255,214,10,${a * 0.2})`);
          ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(c.x + nx * R * 0.12, c.y + ny * R * 0.12); ctx.lineTo(c.x - nx * R * 0.12, c.y - ny * R * 0.12); ctx.lineTo(tp.x - nx * w1, tp.y - ny * w1); ctx.lineTo(tp.x + nx * w1, tp.y + ny * w1); ctx.closePath(); ctx.fill();
          const u = (sec * 1.4) % 1; ctx.strokeStyle = `rgba(255,214,10,${0.6 * (1 - u)})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(c.x + dx * u, c.y + dy * u, w1 * (0.2 + u * 0.8), w1 * (0.2 + u * 0.8) * 0.4, Math.atan2(dy, dx), 0, TAU); ctx.stroke();
        }
        ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(tilt);
        const tint = oct.mode === 'buy' ? '#4ade80' : oct.mode === 'sell' ? '#ff5d4d' : '#ffd60a';
        // resplandor inferior
        const gl = ctx.createRadialGradient(0, R * 0.45, 2, 0, R * 0.45, R * 1.9); gl.addColorStop(0, rgba(tint, 0.35)); gl.addColorStop(1, rgba(tint, 0)); ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, R * 0.45, R * 1.9, 0, TAU); ctx.fill();
        // cúpula de cristal con piloto
        const dg = ctx.createRadialGradient(-R * 0.25, -R * 0.75, R * 0.05, 0, -R * 0.3, R * 0.95); dg.addColorStop(0, 'rgba(210,250,255,.85)'); dg.addColorStop(0.6, 'rgba(90,200,230,.5)'); dg.addColorStop(1, 'rgba(40,110,150,.55)');
        ctx.fillStyle = dg; ctx.strokeStyle = 'rgba(200,240,255,.7)'; ctx.lineWidth = Math.max(1, R * 0.03); ctx.beginPath(); ctx.ellipse(0, -R * 0.12, R * 0.78, R * 0.78, 0, Math.PI, TAU); ctx.fill(); ctx.stroke();
        const lk = tg ? proj(tg.x, 0.8, tg.z) : null; let lx = 0; if (lk) lx = Math.max(-1, Math.min(1, (lk.x - c.x) / (R * 3)));
        ctx.fillStyle = '#6fe08a'; ctx.beginPath(); ctx.ellipse(lx * R * 0.08, -R * 0.38, R * 0.3, R * 0.36, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#0b1a0e'; for (const sg of [-1, 1]) { ctx.beginPath(); ctx.ellipse(lx * R * 0.12 + sg * R * 0.12, -R * 0.4, R * 0.075, R * 0.13, sg * 0.45, 0, TAU); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.ellipse(-R * 0.3, -R * 0.72, R * 0.16, R * 0.07, -0.6, 0, TAU); ctx.fill();
        // plato: casco metálico con aro luminoso
        const hg = ctx.createLinearGradient(0, -R * 0.3, 0, R * 0.5); hg.addColorStop(0, '#d7dbe3'); hg.addColorStop(0.45, '#8d939e'); hg.addColorStop(1, '#2c2f37');
        ctx.fillStyle = hg; ctx.beginPath(); ctx.ellipse(0, 0, R * 1.62, R * 0.46, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = Math.max(1, R * 0.03); ctx.beginPath(); ctx.ellipse(0, -R * 0.04, R * 1.5, R * 0.36, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        ctx.strokeStyle = tint; ctx.lineWidth = Math.max(1.5, R * 0.06); ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.ellipse(0, R * 0.04, R * 1.5, R * 0.34, 0, 0.05, Math.PI - 0.05); ctx.stroke(); ctx.globalAlpha = 1;
        // luces que giran por el borde
        for (let i = 0; i < 9; i++) { const ang = sec * 2.4 + (i / 9) * TAU; const front = Math.sin(ang); const lxp = Math.cos(ang) * R * 1.32; const lyp = R * 0.03 + front * R * 0.2; const on = (Math.floor(sec * 6) + i) % 3 === 0;
          ctx.fillStyle = on ? '#fff7b0' : rgba(tint, 0.9); ctx.globalAlpha = front > -0.2 ? 1 : 0.35; ctx.beginPath(); ctx.arc(lxp, lyp, Math.max(1.2, R * (on ? 0.075 : 0.055)), 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
        // emisor inferior
        ctx.fillStyle = rgba(tint, 0.9); ctx.beginPath(); ctx.ellipse(0, R * 0.42, R * 0.34, R * 0.1, 0, 0, TAU); ctx.fill();
        ctx.font = '700 9px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd60a'; ctx.fillText('SUPERINTELLIGENCE', 0, -R * 1.05);
        ctx.restore();
      } });
      const pu = proj(oct.x, alt + 0.1, oct.z); void pu;
    } else if (STYLE === 'toy') {
      // pulpo de juguete articulado: cabeza redonda amarillo limón, ojos grandes con pupilas, brazos de segmentos con aro verde
      const walking = Math.min(1, spd * 0.35); const by = 1.15 + Math.sin(oct.bob * 2.4) * 0.07 + walking * 0.12;
      const hx = Math.cos(oct.heading); const hz = Math.sin(oct.heading);
      const YEL = '#e4e629'; const GRN = '#58ab3a'; const headC = proj(oct.x, by + 0.55, oct.z);
      const tcol = oct.mode === 'buy' ? [60, 205, 110] : oct.mode === 'sell' ? [255, 70, 55] : [0, 0, 0]; oct.tint += (((oct.mode === 'buy' || oct.mode === 'sell') && tg ? 0.4 : 0) - oct.tint) * 0.05;
      const reachCol = oct.mode === 'sell' ? '#ff5d4d' : '#4ade80';
      { const ag = ctx.createRadialGradient(headC.x, headC.y + 30, 4, headC.x, headC.y + 30, headC.k * 3.8); ag.addColorStop(0, 'rgba(230,230,40,.16)'); ag.addColorStop(1, 'rgba(230,230,40,0)'); ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(headC.x, headC.y + 30, headC.k * 3.8, 0, TAU); ctx.fill(); }
      for (let i = 0; i < 8; i++) {
        const th = (i / 8) * TAU + oct.heading * 0.3 + 0.2; const L = ARM_LEN[i]; const reachArm = oct.reach * (i % 2 === 0 ? 1 : 0.35); const pts = []; let zs = 0; const NS = 11; const cs = i % 2 ? 1 : -1;
        for (let j = 0; j <= NS; j++) {
          const u = j / NS; const lift = walking * Math.max(0, Math.sin(sec * 5 + i * 1.7)) * 0.55 * u;
          const ang = th + Math.sin(sec * 1.6 + i * 1.3 - u * 3) * 0.12 * u + cs * u * u * 0.35; const rr = 0.55 + 2.25 * u * L;
          let px = oct.x + Math.cos(ang) * rr - oct.vx * u * 0.12; let pz = oct.z + Math.sin(ang) * rr - oct.vz * u * 0.12;
          let py = by - 0.55 + 0.45 * Math.sin(u * Math.PI * 0.9) * 0.55 - u * 0.2 + lift + Math.sin(sec * 2.2 - u * 3 + i) * 0.05 * u;
          if (tg && reachArm > 0.01) { const w = Math.pow(u, 1.4) * reachArm; px += (tg.x - px) * w; pz += (tg.z - pz) * w; py += (1.1 + 0.3 * Math.sin(sec * 4 + i) - py) * w; }
          const q = proj(px, Math.max(0.12, py), pz); q.u = u; pts.push(q); zs += q.z;
        }
        const glow = tg && reachArm > 0.3 && oct.mode !== 'tour';
        ops.push({ z: zs / pts.length, d: () => {
          const N = pts.length - 1; const wid = (u) => 0.5 * (1 - u * 0.7) + 0.05;
          const seg = (a, b, wa, wb, fill, off) => { const dx = b.x - a.x; const dy = b.y - a.y; const Ln = Math.hypot(dx, dy) || 1; const nx = -dy / Ln; const ny = dx / Ln; const sh = off || 0; ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(a.x + nx * wa, a.y + ny * wa + sh); ctx.lineTo(b.x + nx * wb, b.y + ny * wb + sh); ctx.lineTo(b.x - nx * wb, b.y - ny * wb + sh); ctx.lineTo(a.x - nx * wa, a.y - ny * wa + sh); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2 + sh, (wa + wb) / 2 * 0.98, 0, TAU); ctx.fill(); };
          for (let j = 0; j < N; j++) { const a = pts[j]; const b = pts[j + 1]; const wa = wid(a.u) * a.k / 2; const wb = wid(b.u) * b.k / 2; const mid = { x: a.x + (b.x - a.x) * 0.5, y: a.y + (b.y - a.y) * 0.5 }; // aro verde por debajo + segmento amarillo con luz arriba
            seg(a, b, wa * 0.96, wb * 0.96, GRN, wa * 0.28);
            const sa = { x: a.x + (b.x - a.x) * 0.06, y: a.y + (b.y - a.y) * 0.06 }; const sb = { x: a.x + (b.x - a.x) * 0.94, y: a.y + (b.y - a.y) * 0.94 };
            const gr = ctx.createLinearGradient(0, mid.y - wa, 0, mid.y + wa); gr.addColorStop(0, '#f6f86a'); gr.addColorStop(0.55, YEL); gr.addColorStop(1, '#b8bb18');
            seg(sa, sb, wa * 0.9, wb * 0.9, gr, 0);
            ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.beginPath(); ctx.arc(mid.x - wa * 0.15, mid.y - wa * 0.45, Math.max(0.6, wa * 0.16), 0, TAU); ctx.fill(); }
          if (glow) { const e = pts[N]; const gg = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, 18); gg.addColorStop(0, rgba(reachCol, 0.9)); gg.addColorStop(1, rgba(reachCol, 0)); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(e.x, e.y, 18, 0, TAU); ctx.fill(); }
        } });
      }
      ops.push({ z: headC.z, d: () => {
        const R = headC.k * 1.05 * (1 + Math.sin(oct.bob * 2.4) * 0.02);
        const g = ctx.createRadialGradient(headC.x - R * 0.35, headC.y - R * 0.45, R * 0.1, headC.x, headC.y, R * 1.05); g.addColorStop(0, '#f8fa7c'); g.addColorStop(0.5, YEL); g.addColorStop(1, '#a9ac12');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(headC.x, headC.y - R * 0.12, R * 0.98, R * 1.08, 0, 0, TAU); ctx.fill();
        if (oct.tint > 0.01) { ctx.fillStyle = `rgba(${tcol[0]},${tcol[1]},${tcol[2]},${oct.tint})`; ctx.beginPath(); ctx.ellipse(headC.x, headC.y - R * 0.12, R * 0.98, R * 1.08, 0, 0, TAU); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.beginPath(); ctx.ellipse(headC.x - R * 0.38, headC.y - R * 0.7, R * 0.2, R * 0.1, -0.5, 0, TAU); ctx.fill();
        const look = tg ? proj(tg.x, 0.8, tg.z) : null; let lx = 0; let ly = 0; if (look) { const dx = look.x - headC.x; const dy = look.y - headC.y; const L2 = Math.hypot(dx, dy) || 1; lx = dx / L2; ly = dy / L2; }
        for (const sgn of [-1, 1]) { // ojos grandes, pupilas que miran a la cripto y bailan al moverse
          const ex = headC.x + sgn * R * 0.4; const ey = headC.y + R * 0.02; const er = R * 0.36;
          ctx.fillStyle = '#fbfbf6'; ctx.strokeStyle = 'rgba(60,60,10,.5)'; ctx.lineWidth = Math.max(1, R * 0.03); ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.fill(); ctx.stroke();
          const jig = Math.min(1, spd * 0.4) * 0.12; const px = ex + (lx * 0.38 + Math.sin(sec * 7 + sgn) * jig) * er; const py = ey + (ly * 0.38 + Math.cos(sec * 6.3 + sgn) * jig + 0.1) * er;
          ctx.fillStyle = '#0b0b0b'; ctx.beginPath(); ctx.arc(px, py, er * 0.5, 0, TAU); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.beginPath(); ctx.arc(px - er * 0.16, py - er * 0.18, er * 0.15, 0, TAU); ctx.fill();
        }
        // parpadeo, mejillas y sonrisa (más grande al comprar)
        const bl = Math.max(0, Math.sin(sec * 1.3 + 1) * 6 - 5.2); // pestañeo breve cada ~5 s
        if (bl > 0) for (const sgn of [-1, 1]) { ctx.fillStyle = YEL; ctx.beginPath(); ctx.ellipse(headC.x + sgn * R * 0.4, headC.y + R * 0.02, R * 0.38, R * 0.38 * Math.min(1, bl * 1.4), 0, 0, TAU); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,120,90,.28)'; for (const sgn of [-1, 1]) { ctx.beginPath(); ctx.ellipse(headC.x + sgn * R * 0.68, headC.y + R * 0.5, R * 0.14, R * 0.08, 0, 0, TAU); ctx.fill(); }
        const sm = oct.mode === 'buy' ? 0.34 : oct.mode === 'sell' ? 0.08 : 0.2;
        ctx.strokeStyle = '#3d4a0c'; ctx.lineWidth = Math.max(1.4, R * 0.045); ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(headC.x, headC.y + R * (0.5 - (oct.mode === 'sell' ? -0.1 : 0.05)), R * 0.2, oct.mode === 'sell' ? Math.PI * 1.15 : 0.15 * Math.PI, oct.mode === 'sell' ? Math.PI * 1.85 : 0.85 * Math.PI); ctx.stroke(); void sm;
      } });
    } else {
    // pulpo realista: manto abultado hacia atrás, cabeza con ojos, membrana entre brazos, brazos cónicos con ventosas y puntas enroscadas
    const by = 2.1 + Math.sin(oct.bob * 2.2) * 0.22 + Math.min(0.8, spd * 0.12);
    const hx = Math.cos(oct.heading); const hz = Math.sin(oct.heading);
    const headC = proj(oct.x + hx * 0.28, by + 0.05, oct.z + hz * 0.28); const mantC = proj(oct.x - hx * 0.55, by + 0.8, oct.z - hz * 0.55);
    // camuflaje: el cuerpo se tiñe de verde al comprar, de rojo al soltar
    const tcol = oct.mode === 'buy' ? [60, 205, 110] : oct.mode === 'sell' ? [255, 70, 55] : [0, 0, 0]; oct.tint += (((oct.mode === 'buy' || oct.mode === 'sell') && tg ? 0.32 : 0) - oct.tint) * 0.05;
    { const ag = ctx.createRadialGradient(headC.x, headC.y + 24, 4, headC.x, headC.y + 24, headC.k * 3.8); ag.addColorStop(0, 'rgba(255,120,50,.22)'); ag.addColorStop(1, 'rgba(255,120,50,0)'); ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(headC.x, headC.y + 24, headC.k * 3.8, 0, TAU); ctx.fill(); }
    const NSEG = 32; const reachCol = oct.mode === 'sell' ? '#ff5d4d' : '#4ade80'; const arms = [];
    for (let i = 0; i < 8; i++) {
      const th = (i / 8) * TAU + oct.heading * 0.35; const reachArm = oct.reach * (i % 2 === 0 ? 1 : 0.35); const pts = []; let zs = 0; const L = ARM_LEN[i]; const cs = i % 3 === 0 ? -1 : 1;
      for (let j = 0; j <= NSEG; j++) {
        const u = j / NSEG; const wob = Math.sin(sec * 2.4 - u * 5 + i * 1.3) * 0.3 * u; const ang = th + wob * 0.5; const rr = 0.4 + 2.1 * u * L;
        let px = oct.x + Math.cos(ang) * rr - oct.vx * u * u * 0.5; let pz = oct.z + Math.sin(ang) * rr - oct.vz * u * u * 0.5;
        let py = by - 0.1 - u * 1.45 * L + Math.sin(sec * 2 - u * 4 + i) * 0.22 * u;
        if (u > 0.64) { const c = (u - 0.64) / 0.36; px -= Math.cos(ang) * c * c * 0.7 * L + -Math.sin(ang) * cs * c * c * 0.5; pz -= Math.sin(ang) * c * c * 0.7 * L + Math.cos(ang) * cs * c * c * 0.5; py += c * c * (0.7 + 0.4 * (i % 2)); }
        if (tg && reachArm > 0.01) { const w = Math.pow(u, 1.5) * reachArm; px += (tg.x - px) * w; pz += (tg.z - pz) * w; py += (1.2 + 0.4 * Math.sin(sec * 4 + i) - py) * w; }
        const q = proj(px, Math.max(0.1, py), pz); q.u = u; q.wx = px; q.wz = pz; pts.push(q); zs += q.z;
        if (j % 5 === 2 && py < 1.2) { const sh = proj(px, 0, pz); ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(sh.x, sh.y, 0.2 * sh.k * (1 - u * 0.6), 0.07 * sh.k, 0, 0, TAU); ctx.fill(); }
      }
      arms.push(pts);
      const glow = tg && reachArm > 0.3 && oct.mode !== 'tour';
      ops.push({ z: zs / pts.length, d: () => {
        const N = pts.length - 1; const wid = (u) => 0.62 * Math.pow(1 - u, 0.85) + 0.05;
        const nrm = (j) => { const a = pts[Math.max(0, j - 1)]; const b = pts[Math.min(N, j + 1)]; const dx = b.x - a.x; const dy = b.y - a.y; const Ln = Math.hypot(dx, dy) || 1; return [-dy / Ln, dx / Ln]; };
        for (let j = 0; j < N; j++) {
          const a = pts[j]; const b = pts[j + 1]; const na = nrm(j); const nb = nrm(j + 1); const wa = wid(a.u) * a.k / 2; const wb = wid(b.u) * b.k / 2;
          const m = Math.pow(a.u, 1.4); const mot = 0.85 + 0.15 * Math.sin(j * 1.7 + i * 2.1); const r = Math.round((150 + 90 * m) * mot); const g = Math.round((42 + 95 * m) * mot); const bl = Math.round((24 + 70 * m) * mot);
          const f = `rgb(${r},${g},${bl})`; ctx.fillStyle = f; ctx.strokeStyle = f; ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(a.x + na[0] * wa, a.y + na[1] * wa); ctx.lineTo(b.x + nb[0] * wb, b.y + nb[1] * wb); ctx.lineTo(b.x - nb[0] * wb, b.y - nb[1] * wb); ctx.lineTo(a.x - na[0] * wa, a.y - na[1] * wa); ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255,215,190,.34)'; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let j = 2; j < N - 1; j++) { const a = pts[j]; const n = nrm(j); const w = wid(a.u) * a.k * 0.27; if (j === 2) ctx.moveTo(a.x - n[0] * w, a.y - n[1] * w); else ctx.lineTo(a.x - n[0] * w, a.y - n[1] * w); } ctx.stroke();
        for (let j = 4; j < N - 1; j += 2) { // ventosas: aro claro y centro oscuro
          const a = pts[j]; const n = nrm(j); const w = wid(a.u) * a.k; const sd = (j % 4 === 0 ? 1 : -1) * 0.2; const rad = Math.max(0.9, w * 0.18); const sx = a.x + n[0] * w * sd; const sy = a.y + n[1] * w * sd;
          ctx.fillStyle = 'rgba(250,222,192,.95)'; ctx.strokeStyle = 'rgba(105,38,20,.6)'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(sx, sy, rad, 0, TAU); ctx.fill(); ctx.stroke();
          ctx.fillStyle = 'rgba(150,70,50,.6)'; ctx.beginPath(); ctx.arc(sx, sy, rad * 0.45, 0, TAU); ctx.fill();
        }
        if (glow) { const e = pts[N]; const gg = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, 18); gg.addColorStop(0, rgba(reachCol, 0.9)); gg.addColorStop(1, rgba(reachCol, 0)); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(e.x, e.y, 18, 0, TAU); ctx.fill(); }
      } });
    }
    // membrana entre los brazos
    for (let i = 0; i < 8; i++) {
      const A = arms[i]; const B = arms[(i + 1) % 8]; const zz = (A[4].z + B[4].z) / 2 + 0.2;
      ops.push({ z: zz, d: () => { ctx.beginPath(); for (let j = 0; j <= 9; j++) ctx.lineTo(A[j].x, A[j].y); for (let j = 9; j >= 0; j--) ctx.lineTo(B[j].x, B[j].y); ctx.closePath(); const g = ctx.createLinearGradient(A[0].x, A[0].y, A[9].x, A[9].y); g.addColorStop(0, 'rgba(120,32,16,.95)'); g.addColorStop(1, 'rgba(200,100,70,.55)'); ctx.fillStyle = g; ctx.fill(); } });
    }
    const body = (c, Rr, R2, ang, bright) => { // elipsoide con piel: gradiente, motas, manchas de cromatóforos y brillo húmedo
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(ang); ctx.beginPath(); ctx.ellipse(0, 0, Rr, R2, 0, 0, TAU);
      const g = ctx.createRadialGradient(-Rr * 0.3, -R2 * 0.55, R2 * 0.08, 0, 0, Rr * 1.3); g.addColorStop(0, bright ? '#f9b08a' : '#f19a73'); g.addColorStop(0.32, '#df5e36'); g.addColorStop(0.78, '#a3321b'); g.addColorStop(1, '#5a170a'); ctx.fillStyle = g; ctx.fill(); ctx.clip();
      for (const bl of BLOTCH) { const rg = ctx.createRadialGradient(bl.x * Rr, bl.y * R2, 0, bl.x * Rr, bl.y * R2, bl.r * Rr); rg.addColorStop(0, bl.dark ? 'rgba(70,14,6,.28)' : 'rgba(255,175,130,.22)'); rg.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = rg; ctx.fillRect(-Rr, -R2, Rr * 2, R2 * 2); }
      for (const sp of SPECKS) { ctx.fillStyle = sp.dark ? `rgba(60,12,4,${sp.a})` : `rgba(255,196,160,${sp.a})`; ctx.beginPath(); ctx.arc(sp.x * Rr, sp.y * R2, sp.r * Rr, 0, TAU); ctx.fill(); }
      if (oct.tint > 0.01) { ctx.fillStyle = `rgba(${tcol[0]},${tcol[1]},${tcol[2]},${oct.tint})`; ctx.fillRect(-Rr, -R2, Rr * 2, R2 * 2); }
      ctx.restore();
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(ang); ctx.strokeStyle = 'rgba(255,235,215,.38)'; ctx.lineWidth = Math.max(1.2, Rr * 0.045); ctx.lineCap = 'round'; ctx.beginPath(); ctx.ellipse(0, 0, Rr * 0.8, R2 * 0.8, 0, Math.PI * 1.15, Math.PI * 1.5); ctx.stroke(); ctx.restore();
    };
    const mantAng = Math.atan2(mantC.y - headC.y, mantC.x - headC.x) - Math.PI / 2 + Math.PI / 2; const breath = 1 + Math.sin(oct.bob * 2.2) * 0.03;
    ops.push({ z: mantC.z, d: () => body(mantC, mantC.k * 1.1 * breath, mantC.k * 1.5 * breath, mantAng - Math.PI / 2, true) });
    ops.push({ z: headC.z, d: () => {
      const R = headC.k * 0.98; body(headC, R * 1.05, R * 0.92, mantAng - Math.PI / 2, false);
      for (const sgn of [-1, 1]) { // ojos sobre la cabeza, con pupila horizontal
        const ex = oct.x + hx * 0.85 + -hz * sgn * 0.5; const ez = oct.z + hz * 0.85 + hx * sgn * 0.5; const e = proj(ex, by + 0.28, ez); if (e.z > headC.z + 0.6) continue; const er = e.k * 0.3;
        ctx.fillStyle = 'rgba(110,30,15,.9)'; ctx.beginPath(); ctx.arc(e.x, e.y + er * 0.12, er * 1.28, 0, TAU); ctx.fill();
        const sg = ctx.createRadialGradient(e.x - er * 0.25, e.y - er * 0.3, er * 0.1, e.x, e.y, er); sg.addColorStop(0, '#f6d27a'); sg.addColorStop(1, '#a8701c'); ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(e.x, e.y, er, 0, TAU); ctx.fill();
        ctx.fillStyle = '#0a0705'; ctx.beginPath(); ctx.ellipse(e.x, e.y, er * 0.68, er * 0.2, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(e.x - er * 0.34, e.y - er * 0.34, Math.max(0.8, er * 0.15), 0, TAU); ctx.fill();
        ctx.strokeStyle = '#4a1408'; ctx.lineWidth = Math.max(1, er * 0.3); ctx.beginPath(); ctx.arc(e.x, e.y, er * 1.06, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
      }
    } });
    }
    // burbujas flotando alrededor
    for (const bu of (STYLE === 'ufo' ? [] : bubbles)) { bu.y += dt * bu.v; if (bu.y > 6) bu.y = 0.1; const q = proj(oct.x + bu.x + Math.sin(sec + bu.ph) * 0.3, bu.y, oct.z + bu.z); const br = Math.max(0.8, bu.r * q.k); ops.push({ z: q.z, d: () => { ctx.strokeStyle = 'rgba(200,225,255,.35)'; ctx.fillStyle = 'rgba(200,225,255,.07)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(q.x, q.y, br, 0, TAU); ctx.fill(); ctx.stroke(); ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.beginPath(); ctx.arc(q.x - br * 0.3, q.y - br * 0.3, br * 0.22, 0, TAU); ctx.fill(); } }); }
    for (const p of parts) { p.x += p.vx; p.y += p.vy; p.z += p.vz; p.vy -= 0.006; p.life -= dt * 0.9; if (p.y < 0.05) { p.y = 0.05; p.vy *= -0.4; } if (p.life > 0) sphere(p.x, p.y, p.z, 0.1, p.col, Math.min(1, p.life * 1.5)); }
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
    ops.sort((a, b) => b.z - a.z); for (const o of ops) o.d();
    // etiquetas
    ctx.textAlign = 'center';
    for (const { n, top, col } of labels) { ctx.globalAlpha = n.al; pill(n.label, top.x, top.y - 16, col, true); if (n.sub) { ctx.font = '600 9px ui-monospace,Menlo,monospace'; ctx.fillStyle = rgba(col, 0.95); ctx.fillText(n.sub.split(' ')[0], top.x, top.y - 28); } ctx.globalAlpha = 1; }
    for (const f of floaters) { f.y += 0.03; f.life -= dt * 0.55; const p = proj(f.x, f.y, f.z); ctx.globalAlpha = Math.max(0, f.life); pill(f.text, p.x, p.y, f.col, true); ctx.globalAlpha = 1; }
    for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].life <= 0) floaters.splice(i, 1);
    // HUD
    ctx.fillStyle = 'rgba(8,8,11,.72)'; ctx.beginPath(); ctx.roundRect(8, 8, Math.min(W - 16, 300), 38, 8); ctx.fill();
    ctx.textAlign = 'left'; ctx.fillStyle = '#ffd60a'; ctx.font = '700 11px ui-monospace,Menlo,monospace'; ctx.fillText(`● ${tr(hud.title)}`.toUpperCase(), 16, 24);
    ctx.fillStyle = '#c9c6b5'; ctx.font = '600 10px ui-monospace,Menlo,monospace'; ctx.fillText(hud.sub.slice(0, 46), 16, 38);
    if (!still) requestAnimationFrame(frame);
  };

  size(); layout(d); for (const n of isl.values()) { n.w = n.tw; n.al = 1; }
  if (isl.size) { const f = [...isl.values()].sort((a, b) => b.tw - a.tw)[0]; oct.x = f.x * 0.4; oct.z = f.z * 0.4; }
  new ResizeObserver(() => { size(); if (still) requestAnimationFrame(frame); }).observe(cv); requestAnimationFrame(frame);
  return { update(nd) { d = nd; layout(nd); }, destroy() { alive = false; } };
}
