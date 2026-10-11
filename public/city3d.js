// Ciudad futurista de los agentes. Motor 3D propio en canvas 2D (sin librerías, respeta la política de seguridad).
// Cada edificio es un agente real (su altura sale de cuánto ha corrido y propuesto), la torre central es el Director,
// y los drones viajan por las calles entre el Director y cada agente activo. Solo tú apruebas: cada propuesta pendiente
// aparece como una baliza sobre la torre del Director.
const TAU = Math.PI * 2;
const KC = { ok: '#ffd60a', idle: '#8a8776', off: '#4a4a44', run: '#4ade80' };
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (h, a) => { const [r, g, b] = hex(h); return `rgba(${r},${g},${b},${a})`; };
const rnd = (() => { let x = 4242; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; })();
const SKY = Array.from({ length: 46 }, () => { const a = rnd() * TAU; const r = 9 + rnd() * 8; return { x: Math.cos(a) * r, z: Math.sin(a) * r, h: 0.6 + rnd() * 2.6, w: 0.5 + rnd() * 0.5, ph: rnd() * TAU }; });

export function createCity3D(cv, d0, opt = {}) {
  const say = (t, hi) => { try { if (opt.onSay && t) opt.onSay(t, hi); } catch { /* sin voz */ } };
  let sel = -1; let A = [];
  const ctx = cv.getContext('2d'); const dpr = Math.min(2, window.devicePixelRatio || 1); const H = 340; let W = 340; let d = d0; let alive = true; let last = performance.now();
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cam = { az: 0.5, el: 0.7, D: 27 }; let hud = { title: 'Ciudad de agentes', sub: 'esperando datos' }; let focus = 0; let focusUntil = 0;
  const size = () => { W = cv.clientWidth || 340; cv.style.height = `${H}px`; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const proj = (x, y, z) => {
    const ca = Math.cos(cam.az); const sa = Math.sin(cam.az); const x1 = x * ca - z * sa; const z1 = x * sa + z * ca; const dy = y - 1.2;
    const ce = Math.cos(cam.el); const se = Math.sin(cam.el); const y2 = dy * ce + z1 * se; const z2 = -dy * se + z1 * ce + cam.D; const k = (W * 1.25) / Math.max(2, z2);
    return { x: W / 2 + x1 * k, y: H * 0.68 - y2 * k, k, z: z2 };
  };
  const ufo = { x: 0, z: 0, vx: 0, vz: 0, bob: 0 };
  const agents = () => d.nodes.map((n, i, a) => { const ang = (i / Math.max(1, a.length)) * TAU - 1.1; const r = 6.2; return { ...n, i, x: Math.cos(ang) * r, z: Math.sin(ang) * r, h: 1 + Math.min(3.2, (n.w || 0) * 3 + (n.kind === 'ok' ? 0.9 : n.kind === 'idle' ? 0.4 : 0)), ang }; });
  const poly = (pts, fill, stroke) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); } };
  // edificio: caja con dos caras visibles, ventanas encendidas y techo luminoso
  const building = (x, z, w, h, col, sec, lit, ph) => {
    const c = [[-w, -w], [w, -w], [w, w], [-w, w]].map(([dx, dz]) => ({ b: proj(x + dx, 0, z + dz), t: proj(x + dx, h, z + dz) }));
    const faces = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => ({ a, b, z: (c[a].b.z + c[b].b.z) / 2 })).sort((p, q) => q.z - p.z).slice(2);
    faces.forEach((f, fi) => { poly([c[f.a].b, c[f.b].b, c[f.b].t, c[f.a].t], fi ? rgba(col, 0.22) : rgba(col, 0.1), rgba(col, 0.55));
      for (let r = 1; r < Math.floor(h * 2.2); r++) for (let q = 0; q < 3; q++) { if (((r * 7 + q * 3 + Math.floor(ph * 9)) % 5) > (lit ? 2 : 0)) continue; const u = (q + 0.5) / 3; const v = r / (h * 2.2); const px = c[f.a].b.x + (c[f.b].b.x - c[f.a].b.x) * u; const py = (c[f.a].b.y + (c[f.b].b.y - c[f.a].b.y) * u) + ((c[f.a].t.y - c[f.a].b.y) * v); ctx.fillStyle = rgba(col, 0.75 * (0.6 + 0.4 * Math.sin(sec * 2 + r + q + ph))); ctx.fillRect(px - 1, py - 1, 2.2, 2.2); } });
    poly(c.map((p) => p.t), rgba(col, 0.28), rgba(col, 0.95));
    return proj(x, h, z);
  };

  const frame = (now) => {
    if (!alive || !document.body.contains(cv)) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; const sec = now / 1000; cam.az += dt * 0.1;
    A = agents(); const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#04040a'); bg.addColorStop(0.55, '#0b0a08'); bg.addColorStop(1, '#15120a'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { const sx = (i * 97.3) % W; const sy = (i * 41.7) % (H * 0.4); ctx.fillStyle = `rgba(255,240,200,${0.25 + 0.3 * Math.sin(sec * 1.5 + i)})`; ctx.fillRect(sx, sy, 1.2, 1.2); }
    ctx.lineWidth = 1;
    for (let i = -16; i <= 16; i += 2) for (const [ax, az, bx, bz] of [[i, -16, i, 16], [-16, i, 16, i]]) { const a = proj(ax, 0, az); const b = proj(bx, 0, bz); ctx.strokeStyle = `rgba(255,214,10,${i % 6 === 0 ? 0.13 : 0.05})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    // calles Director → agente, con paquetes de luz que viajan
    const cen = proj(0, 0, 0);
    for (const a of A) { const p = proj(a.x, 0, a.z); const on = a.kind === 'ok'; ctx.strokeStyle = rgba(KC[a.kind] || KC.idle, on ? 0.45 : 0.15); ctx.lineWidth = on ? 2 : 1; ctx.beginPath(); ctx.moveTo(cen.x, cen.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      if (on) for (let k = 0; k < 3; k++) { const u = ((sec * 0.35 + k / 3 + a.i * 0.17) % 1); const out = (a.i + k) % 2 === 0; const t = out ? u : 1 - u; ctx.fillStyle = out ? '#ffd60a' : '#4ade80'; ctx.beginPath(); ctx.arc(cen.x + (p.x - cen.x) * t, cen.y + (p.y - cen.y) * t, 2.4, 0, TAU); ctx.fill(); } }
    // traspasos entre agentes: línea punteada del que entrega al que recibe, con un paquete viajando
    ctx.setLineDash([3, 5]); for (const a of A) { const t = a.to >= 0 ? A[a.to] : null; if (!t || a.kind !== 'ok' || t.kind !== 'ok') continue; const p1 = proj(a.x, 1.2, a.z); const p2 = proj(t.x, 1.2, t.z); ctx.strokeStyle = 'rgba(120,220,255,.55)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      const u = (sec * 0.4 + a.i * 0.23) % 1; ctx.setLineDash([]); ctx.fillStyle = '#8fe3ff'; ctx.beginPath(); ctx.arc(p1.x + (p2.x - p1.x) * u, p1.y + (p2.y - p1.y) * u, 3, 0, TAU); ctx.fill(); ctx.setLineDash([3, 5]); }
    ctx.setLineDash([]);
    // todo lo alto se dibuja de lejos a cerca
    const items = [...SKY.map((s) => ({ z: proj(s.x, 0, s.z).z, d: () => building(s.x, s.z, s.w, s.h, '#8a8776', sec, false, s.ph) })),
      ...A.map((a) => ({ z: proj(a.x, 0, a.z).z, d: () => { const top = building(a.x, a.z, 0.9, a.h, KC[a.kind] || KC.idle, sec, a.kind === 'ok', a.i); a.top = top; } })),
      { z: cen.z, d: () => { const top = building(0, 0, 1.15, 5.4, '#ffd60a', sec, true, 3); const ring = (hh, rr, sp) => { ctx.strokeStyle = 'rgba(255,214,10,.8)'; ctx.lineWidth = 1.6; ctx.beginPath(); for (let i = 0; i <= 28; i++) { const q = proj(Math.cos(i / 28 * TAU + sec * sp) * rr, hh, Math.sin(i / 28 * TAU + sec * sp) * rr); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); } ctx.stroke(); };
        ring(6.0, 1.6, 1.2); ring(6.5, 1.2, -1.7); const orb = proj(0, 7.2 + Math.sin(sec * 2) * 0.15, 0); const g = ctx.createRadialGradient(orb.x, orb.y, 1, orb.x, orb.y, orb.k * 1.3); g.addColorStop(0, 'rgba(255,240,150,1)'); g.addColorStop(1, 'rgba(255,214,10,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(orb.x, orb.y, orb.k * 1.3, 0, TAU); ctx.fill();
        const np = Math.min(6, d.pending || 0); for (let i = 0; i < np; i++) { const q = proj(Math.cos(sec * 1.4 + i / np * TAU) * 2.1, 6.0 + Math.sin(sec * 3 + i) * 0.2, Math.sin(sec * 1.4 + i / np * TAU) * 2.1); ctx.fillStyle = '#ff9d2e'; ctx.shadowColor = '#ff9d2e'; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(q.x, q.y, 3.4, 0, TAU); ctx.fill(); ctx.shadowBlur = 0; }
        ctx.font = '700 11px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd60a'; ctx.fillText('DIRECTOR', top.x, top.y - orb.k * 2.1); } }];
    // drones de los agentes activos: salen del Director, van a su edificio y regresan
    A.filter((a) => a.kind === 'ok').forEach((a) => { const ph = (sec * 0.22 + a.i * 0.31) % 1; const t = ph < 0.5 ? ph * 2 : (1 - ph) * 2; const e = t * t * (3 - 2 * t); const x = a.x * e; const z = a.z * e; const y = 1.8 + Math.sin(sec * 3 + a.i) * 0.2 + Math.sin(e * Math.PI) * 1.6;
      items.push({ z: proj(x, y, z).z - 0.3, d: () => { const q = proj(x, y, z); a.dx = q.x; a.dy = q.y; a.dr = q.k * 0.3; const r = q.k * 0.3; ctx.fillStyle = 'rgba(0,0,0,.3)'; const s = proj(x, 0, z); ctx.beginPath(); ctx.ellipse(s.x, s.y, r * 1.4, r * 0.5, 0, 0, TAU); ctx.fill();
        const gg = ctx.createLinearGradient(0, q.y - r, 0, q.y + r); gg.addColorStop(0, '#e6e9f0'); gg.addColorStop(1, '#4a4f5a'); ctx.fillStyle = gg; ctx.beginPath(); ctx.ellipse(q.x, q.y, r * 1.5, r * 0.5, 0, 0, TAU); ctx.fill(); ctx.fillStyle = 'rgba(120,220,255,.8)'; ctx.beginPath(); ctx.ellipse(q.x, q.y - r * 0.25, r * 0.6, r * 0.45, 0, Math.PI, TAU); ctx.fill(); ctx.fillStyle = '#ffd60a'; ctx.beginPath(); ctx.arc(q.x + Math.sin(sec * 8 + a.i) * r, q.y + r * 0.1, Math.max(1, r * 0.14), 0, TAU); ctx.fill(); } }); });
    // OVNI con IA: patrulla la ciudad, se coloca sobre el agente enfocado y lo escanea con un haz
    { const fa0 = A[sel >= 0 ? sel : focus]; const gx = fa0 ? fa0.x * 0.8 : 0; const gz = fa0 ? fa0.z * 0.8 : 0; ufo.vx += (gx - ufo.x) * 0.6 * dt; ufo.vz += (gz - ufo.z) * 0.6 * dt; ufo.vx *= 0.94; ufo.vz *= 0.94; ufo.x += ufo.vx * dt * 3; ufo.z += ufo.vz * dt * 3; ufo.bob += dt;
      const alt = 7.4 + Math.sin(ufo.bob * 1.7) * 0.25; const c = proj(ufo.x, alt, ufo.z); const R = c.k * 0.85; const tgt = fa0 && fa0.top ? fa0.top : null;
      const fw = proj(ufo.x + ufo.vx * 0.4, alt, ufo.z + ufo.vz * 0.4); const tilt = Math.max(-0.28, Math.min(0.28, (fw.x - c.x) * 0.03)); const tint = sel >= 0 ? '#4ade80' : '#ffd60a';
      items.push({ z: -1, d: () => {
        if (tgt) { const dx = tgt.x - c.x; const dy = tgt.y - c.y; const L = Math.hypot(dx, dy) || 1; const nx = -dy / L; const ny = dx / L; const w1 = R * 0.9; const g = ctx.createLinearGradient(c.x, c.y, tgt.x, tgt.y); g.addColorStop(0, rgba(tint, 0.38)); g.addColorStop(1, rgba(tint, 0.06));
          ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(c.x + nx * R * 0.15, c.y + ny * R * 0.15); ctx.lineTo(c.x - nx * R * 0.15, c.y - ny * R * 0.15); ctx.lineTo(tgt.x - nx * w1, tgt.y - ny * w1); ctx.lineTo(tgt.x + nx * w1, tgt.y + ny * w1); ctx.closePath(); ctx.fill();
          const u = (sec * 1.3) % 1; ctx.strokeStyle = rgba(tint, 0.7 * (1 - u)); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(c.x + dx * u, c.y + dy * u, w1 * (0.2 + u * 0.8), w1 * (0.2 + u * 0.8) * 0.4, Math.atan2(dy, dx), 0, TAU); ctx.stroke(); }
        ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(tilt);
        const gl = ctx.createRadialGradient(0, R * 0.4, 2, 0, R * 0.4, R * 1.9); gl.addColorStop(0, rgba(tint, 0.35)); gl.addColorStop(1, rgba(tint, 0)); ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, R * 0.4, R * 1.9, 0, TAU); ctx.fill();
        const dg = ctx.createRadialGradient(-R * 0.25, -R * 0.75, R * 0.05, 0, -R * 0.3, R * 0.95); dg.addColorStop(0, 'rgba(210,250,255,.85)'); dg.addColorStop(0.6, 'rgba(90,200,230,.5)'); dg.addColorStop(1, 'rgba(40,110,150,.55)');
        ctx.fillStyle = dg; ctx.strokeStyle = 'rgba(200,240,255,.7)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(0, -R * 0.12, R * 0.78, R * 0.78, 0, Math.PI, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#6fe08a'; ctx.beginPath(); ctx.ellipse(0, -R * 0.38, R * 0.3, R * 0.36, 0, 0, TAU); ctx.fill(); ctx.fillStyle = '#0b1a0e'; for (const sg of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sg * R * 0.12, -R * 0.4, R * 0.075, R * 0.13, sg * 0.45, 0, TAU); ctx.fill(); }
        const hg = ctx.createLinearGradient(0, -R * 0.3, 0, R * 0.5); hg.addColorStop(0, '#d7dbe3'); hg.addColorStop(0.45, '#8d939e'); hg.addColorStop(1, '#2c2f37'); ctx.fillStyle = hg; ctx.beginPath(); ctx.ellipse(0, 0, R * 1.62, R * 0.46, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = tint; ctx.lineWidth = Math.max(1.5, R * 0.06); ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.ellipse(0, R * 0.04, R * 1.5, R * 0.34, 0, 0.05, Math.PI - 0.05); ctx.stroke(); ctx.globalAlpha = 1;
        for (let i = 0; i < 9; i++) { const ang = sec * 2.4 + (i / 9) * TAU; const fr = Math.sin(ang); const on = (Math.floor(sec * 6) + i) % 3 === 0; ctx.fillStyle = on ? '#fff7b0' : rgba(tint, 0.9); ctx.globalAlpha = fr > -0.2 ? 1 : 0.35; ctx.beginPath(); ctx.arc(Math.cos(ang) * R * 1.32, R * 0.03 + fr * R * 0.2, Math.max(1.2, R * (on ? 0.075 : 0.055)), 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
        ctx.font = '700 9px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd60a'; ctx.fillText('SUPERINTELLIGENCE', 0, -R * 1.05);
        ctx.restore(); } }); }
    items.sort((p, q) => q.z - p.z).forEach((o) => o.d());
    // etiquetas
    ctx.font = '600 10px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center';
    for (const a of A) if (a.top) { const w = ctx.measureText(a.label).width + 12; const col = KC[a.kind] || KC.idle; ctx.fillStyle = a.i === (sel >= 0 ? sel : -2) ? 'rgba(60,50,0,.95)' : 'rgba(8,8,11,.8)'; ctx.strokeStyle = rgba(col, a.i === sel ? 1 : 0.6); ctx.beginPath(); ctx.roundRect(a.top.x - w / 2, a.top.y - 26, w, 16, 6); ctx.fill(); ctx.stroke(); ctx.fillStyle = col; ctx.fillText(a.label, a.top.x, a.top.y - 14); }
    // globo de texto sobre el dron del agente enfocado o elegido: dice lo que está haciendo
    const fa = A[sel >= 0 ? sel : focus];
    if (fa && fa.kind === 'ok' && fa.dx !== undefined) { const txt = String(fa.sub || '').slice(0, 30); const w = ctx.measureText(txt).width + 14; const bx = Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, fa.dx)); const by = fa.dy - fa.dr * 2.6 - 12;
      ctx.fillStyle = 'rgba(255,248,210,.95)'; ctx.beginPath(); ctx.roundRect(bx - w / 2, by - 11, w, 20, 7); ctx.fill(); ctx.beginPath(); ctx.moveTo(fa.dx - 4, by + 9); ctx.lineTo(fa.dx + 4, by + 9); ctx.lineTo(fa.dx, by + 15); ctx.fill();
      ctx.fillStyle = '#1a1706'; ctx.textAlign = 'center'; ctx.font = '600 10px ui-monospace,Menlo,monospace'; ctx.fillText(txt, bx, by + 3); }
    // HUD: recorre los agentes y cuenta qué hace cada uno
    if (sec > focusUntil && A.length) { if (sel >= 0) sel = -1; focus = (focus + 1) % A.length; focusUntil = sec + 3.2; const a = A[focus]; say(a.say || `${a.label}. ${a.sub || ''}`, false); hud = { title: `${a.label}${a.kind === 'off' ? ' · apagado' : a.kind === 'ok' ? ' · activo' : ' · en pausa'}`, sub: a.sub || 'sin notas todavía' }; }
    ctx.fillStyle = 'rgba(8,8,11,.72)'; ctx.beginPath(); ctx.roundRect(8, 8, Math.min(W - 16, 330), 38, 8); ctx.fill();
    ctx.textAlign = 'left'; ctx.fillStyle = '#ffd60a'; ctx.font = '700 11px ui-monospace,Menlo,monospace'; ctx.fillText(`● ${hud.title}`.toUpperCase().slice(0, 40), 16, 24);
    ctx.fillStyle = '#c9c6b5'; ctx.font = '600 10px ui-monospace,Menlo,monospace'; ctx.fillText(String(hud.sub).slice(0, 48), 16, 38);
    if (!still) requestAnimationFrame(frame);
  };
  // tocar un edificio (o su etiqueta) abre el detalle de ese agente
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect(); const px = e.clientX - r.left; const py = e.clientY - r.top; let best = -1; let bd = 46;
    for (const a of A) if (a.top) { const dd = Math.min(Math.hypot(px - a.top.x, py - (a.top.y - 18)), Math.hypot(px - a.top.x, py - (a.top.y + 20))); if (dd < bd) { bd = dd; best = a.i; } }
    if (best >= 0) { sel = best; focus = best; focusUntil = performance.now() / 1000 + 9; const a = A[best]; hud = { title: `${a.label}${a.kind === 'off' ? ' · apagado' : a.kind === 'ok' ? ' · activo' : ' · en pausa'}`, sub: a.sub || 'sin notas todavía' }; if (opt.onPick) opt.onPick(best); }
  });
  size(); new ResizeObserver(() => { size(); if (still) requestAnimationFrame(frame); }).observe(cv); requestAnimationFrame(frame);
  return { update(nd) { d = nd; }, destroy() { alive = false; } };
}
