// Pulpo 3D sobre un mapa de criptos. Motor 3D propio en canvas 2D (proyección en perspectiva, orden por profundidad):
// sin librerías ni WebGL, así funciona en cualquier teléfono y respeta la política de seguridad (solo scripts propios).
// Todo lo que muestra sale de datos reales del bot: cada isla es una cripto, su altura es la fuerza de la señal y
// el pulpo va evaluando una por una; cuando el bot compra o suelta, el pulpo va a esa isla y lo ejecuta a la vista.
const TAU = Math.PI * 2;
const COLORS = { held: '#4ade80', ok: '#ffd60a', idle: '#8a8776', off: '#4a4a44', hot: '#ff5d4d', buy: '#4ade80', keep: '#ffd60a', drop: '#ff5d4d' };
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (h, a) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; };
const shade = (h, k) => { const [r, g, b] = hexRgb(h); const f = (v) => Math.max(0, Math.min(255, Math.round(v * k))); return `rgb(${f(r)},${f(g)},${f(b)})`; };

// Motas de la piel del manto, fijas (generadas con una semilla para que no parpadeen).
const SPECKS = (() => { let x = 12345; const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; const a = []; for (let i = 0; i < 130; i++) { const r = Math.sqrt(rnd()) * 0.95; const t = rnd() * TAU; a.push({ x: Math.cos(t) * r * 0.9, y: Math.sin(t) * r, r: 0.012 + rnd() * 0.04, a: 0.1 + rnd() * 0.3, dark: rnd() > 0.35 }); } return a; })();

export function createOcto3D(cv, d0) {
  const ctx = cv.getContext('2d'); const dpr = Math.min(2, window.devicePixelRatio || 1);
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let d = d0; let W = 340; const H = 340;
  const isl = new Map(); // islas (criptos)
  const parts = []; const floaters = []; const rings = [];
  const events = []; // acciones pendientes: { label, type: 'buy' | 'sell' }
  const prev = new Map();
  const oct = { x: 0, z: 0, vx: 0, vz: 0, heading: 0, target: null, mode: 'tour', until: 0, reach: 0, bob: 0 };
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
    if (ev && isl.has(ev.label)) { oct.target = isl.get(ev.label); oct.mode = ev.type; oct.until = t + 2800; return; }
    const list = [...isl.values()].filter((n) => !n.gone).sort((a, b) => b.tw - a.tw);
    if (!list.length) { oct.target = null; oct.until = t + 1500; return; }
    tourIdx = (tourIdx + 1) % list.length; oct.target = list[tourIdx]; oct.mode = 'tour'; oct.until = t + 2400;
    rings.push({ x: oct.target.x, z: oct.target.z, r: 0.5, col: COLORS[oct.target.kind] || COLORS.idle });
    const n = oct.target; const row = n.row;
    hud = { title: `Evaluando ${n.label}`, sub: row ? `${row.state}${row.score ? ` · puntaje ${row.score.toFixed(1)}` : ''}${row.note ? ` · ${row.note}` : ''}` : (n.sub || 'vigilando') };
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
      if (dist <= 1.8 && (oct.mode === 'buy' || oct.mode === 'sell') && !oct.did) { oct.did = true; const col = oct.mode === 'buy' ? '#4ade80' : '#ff5d4d'; burst(tg.x, 1.2, tg.z, col, 38); rings.push({ x: tg.x, z: tg.z, r: 0.5, col }); floaters.push({ x: tg.x, y: 3.4, z: tg.z, text: oct.mode === 'buy' ? `COMPRA ${tg.label}` : `SUELTA ${tg.label}`, col, life: 1 }); hud = { title: `${oct.mode === 'buy' ? 'Comprando' : 'Soltando'} ${tg.label}`, sub: tg.row ? `${tg.row.state}${tg.row.note ? ` · ${tg.row.note}` : ''}` : tg.sub }; }
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
    // sombra del pulpo
    groundCircle(oct.x, oct.z, 1.2, 'rgba(0,0,0,.35)', null);
    // pulpo realista: manto con textura, ojos con pupila horizontal y tentáculos cónicos con ventosas y puntas enroscadas
    const by = 2.1 + Math.sin(oct.bob * 2.2) * 0.22 + Math.min(0.8, spd * 0.12);
    const hx = Math.cos(oct.heading); const hz = Math.sin(oct.heading);
    const headC = proj(oct.x, by + 0.2, oct.z);
    { const ag = ctx.createRadialGradient(headC.x, headC.y + 20, 4, headC.x, headC.y + 20, headC.k * 3.6); ag.addColorStop(0, 'rgba(255,120,50,.2)'); ag.addColorStop(1, 'rgba(255,120,50,0)'); ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(headC.x, headC.y + 20, headC.k * 3.6, 0, TAU); ctx.fill(); }
    const NSEG = 30; const reachCol = oct.mode === 'sell' ? '#ff5d4d' : '#4ade80';
    for (let i = 0; i < 8; i++) {
      const th = (i / 8) * TAU + oct.heading * 0.35; const reachArm = oct.reach * (i % 2 === 0 ? 1 : 0.35); const pts = []; let zs = 0;
      for (let j = 0; j <= NSEG; j++) {
        const u = j / NSEG; const wob = Math.sin(sec * 2.4 - u * 5 + i * 1.3) * 0.3 * u; const ang = th + wob * 0.5; const rr = 0.45 + 2.0 * u;
        let px = oct.x + Math.cos(ang) * rr - oct.vx * u * u * 0.5; let pz = oct.z + Math.sin(ang) * rr - oct.vz * u * u * 0.5;
        let py = by - 0.15 - u * 1.4 + Math.sin(sec * 2 - u * 4 + i) * 0.22 * u;
        if (u > 0.66) { const c = (u - 0.66) / 0.34; px -= Math.cos(ang) * c * c * 0.75; pz -= Math.sin(ang) * c * c * 0.75; py += c * c * 1.0; } // punta enroscada
        if (tg && reachArm > 0.01) { const w = Math.pow(u, 1.5) * reachArm; px += (tg.x - px) * w; pz += (tg.z - pz) * w; py += (1.2 + 0.4 * Math.sin(sec * 4 + i) - py) * w; }
        const q = proj(px, Math.max(0.1, py), pz); q.u = u; pts.push(q); zs += q.z;
      }
      const glow = tg && reachArm > 0.3 && oct.mode !== 'tour';
      ops.push({ z: zs / pts.length, d: () => {
        const N = pts.length - 1; const wid = (u) => 0.6 * Math.pow(1 - u, 0.85) + 0.05;
        const nrm = (j) => { const a = pts[Math.max(0, j - 1)]; const b = pts[Math.min(N, j + 1)]; const dx = b.x - a.x; const dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1; return [-dy / L, dx / L]; };
        for (let j = 0; j < N; j++) {
          const a = pts[j]; const b = pts[j + 1]; const na = nrm(j); const nb = nrm(j + 1); const wa = wid(a.u) * a.k / 2; const wb = wid(b.u) * b.k / 2;
          const m = Math.pow(a.u, 1.4); const r = Math.round(150 + 90 * m); const g = Math.round(42 + 95 * m); const bl = Math.round(24 + 70 * m);
          const f = `rgb(${r},${g},${bl})`; ctx.fillStyle = f; ctx.strokeStyle = f; ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(a.x + na[0] * wa, a.y + na[1] * wa); ctx.lineTo(b.x + nb[0] * wb, b.y + nb[1] * wb); ctx.lineTo(b.x - nb[0] * wb, b.y - nb[1] * wb); ctx.lineTo(a.x - na[0] * wa, a.y - na[1] * wa); ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255,205,175,.28)'; ctx.lineWidth = 1.1; ctx.beginPath(); // brillo húmedo
        for (let j = 2; j < N - 1; j++) { const a = pts[j]; const n = nrm(j); const w = wid(a.u) * a.k * 0.28; if (j === 2) ctx.moveTo(a.x - n[0] * w, a.y - n[1] * w); else ctx.lineTo(a.x - n[0] * w, a.y - n[1] * w); } ctx.stroke();
        for (let j = 4; j < N - 1; j += 2) { // ventosas pálidas
          const a = pts[j]; const n = nrm(j); const w = wid(a.u) * a.k; const sd = (j % 4 === 0 ? 1 : -1) * 0.2; const rad = Math.max(0.8, w * 0.17);
          ctx.fillStyle = 'rgba(248,216,184,.92)'; ctx.strokeStyle = 'rgba(110,40,22,.55)'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(a.x + n[0] * w * sd, a.y + n[1] * w * sd, rad, 0, TAU); ctx.fill(); ctx.stroke();
        }
        if (glow) { const e = pts[N]; const gg = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, 16); gg.addColorStop(0, rgba(reachCol, 0.85)); gg.addColorStop(1, rgba(reachCol, 0)); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(e.x, e.y, 16, 0, TAU); ctx.fill(); }
      } });
    }
    ops.push({ z: headC.z, d: () => { // manto
      const R = headC.k * 1.18 * (1 + Math.sin(oct.bob * 2.2) * 0.025); const cx = headC.x; const cy = headC.y - R * 0.1; const tilt = -0.22 + Math.sin(sec * 0.8) * 0.04;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt);
      ctx.beginPath(); ctx.ellipse(0, -R * 0.2, R * 0.9, R * 1.12, 0, 0, TAU);
      const g = ctx.createRadialGradient(-R * 0.32, -R * 0.62, R * 0.08, 0, 0, R * 1.35); g.addColorStop(0, '#f7a87f'); g.addColorStop(0.32, '#df5e36'); g.addColorStop(0.78, '#a3321b'); g.addColorStop(1, '#5e180b'); ctx.fillStyle = g; ctx.fill(); ctx.clip();
      for (const sp of SPECKS) { ctx.fillStyle = sp.dark ? `rgba(60,12,4,${sp.a})` : `rgba(255,196,160,${sp.a})`; ctx.beginPath(); ctx.arc(sp.x * R, -R * 0.2 + sp.y * R * 1.1, sp.r * R, 0, TAU); ctx.fill(); }
      ctx.strokeStyle = 'rgba(70,14,5,.35)'; ctx.lineWidth = Math.max(1, R * 0.03); for (const k of [-0.55, 0.1, 0.62]) { ctx.beginPath(); ctx.ellipse(k * R * 0.9, R * 0.3, R * 0.22, R * 0.7, 0.3 * k, 0.2, 2.4); ctx.stroke(); }
      ctx.restore();
      for (const sgn of [-1, 1]) { // ojos con pupila horizontal
        const ex = oct.x + hx * 0.78 + -hz * sgn * 0.42; const ez = oct.z + hz * 0.78 + hx * sgn * 0.42; const e = proj(ex, by + 0.12, ez); if (e.z > headC.z + 0.55) continue; const er = e.k * 0.27;
        const sg = ctx.createRadialGradient(e.x - er * 0.25, e.y - er * 0.3, er * 0.1, e.x, e.y, er); sg.addColorStop(0, '#f6d27a'); sg.addColorStop(1, '#a8701c'); ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(e.x, e.y, er, 0, TAU); ctx.fill();
        ctx.fillStyle = '#0a0705'; ctx.beginPath(); ctx.ellipse(e.x, e.y, er * 0.66, er * 0.2, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(e.x - er * 0.32, e.y - er * 0.32, Math.max(0.8, er * 0.14), 0, TAU); ctx.fill();
        ctx.strokeStyle = '#4a1408'; ctx.lineWidth = Math.max(1, er * 0.28); ctx.beginPath(); ctx.arc(e.x, e.y, er * 1.04, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
      }
    } });
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
    ctx.textAlign = 'left'; ctx.fillStyle = '#ffd60a'; ctx.font = '700 11px ui-monospace,Menlo,monospace'; ctx.fillText(`● ${hud.title}`.toUpperCase(), 16, 24);
    ctx.fillStyle = '#c9c6b5'; ctx.font = '600 10px ui-monospace,Menlo,monospace'; ctx.fillText(hud.sub.slice(0, 46), 16, 38);
    if (!still) requestAnimationFrame(frame);
  };

  size(); layout(d); for (const n of isl.values()) { n.w = n.tw; n.al = 1; }
  if (isl.size) { const f = [...isl.values()].sort((a, b) => b.tw - a.tw)[0]; oct.x = f.x * 0.4; oct.z = f.z * 0.4; }
  new ResizeObserver(() => { size(); if (still) requestAnimationFrame(frame); }).observe(cv); requestAnimationFrame(frame);
  return { update(nd) { d = nd; layout(nd); }, destroy() { alive = false; } };
}
