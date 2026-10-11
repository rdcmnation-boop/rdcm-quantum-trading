// ML mínimo y honesto: regresión logística con validación "walk-forward" (entrena en el pasado, prueba en el futuro).
// Predice si la próxima vela de 1 h cierra al alza. Casi siempre NO supera la línea base: el sistema lo reporta tal cual.
import { rsi, sma, stdev } from './indicators.js';

export const FEATURE_NAMES = ['retorno 1h', 'retorno 3h', 'retorno 6h', 'retorno 12h', 'volatilidad 12h', 'RSI(14)', 'distancia a SMA24'];
const WINDOW = 61;

// Características con la información disponible hasta la vela i (sin mirar el futuro).
export function features(closes, i) {
  const w = closes.slice(Math.max(0, i - WINDOW + 1), i + 1);
  const n = w.length - 1;
  const r = (k) => Math.log(w[n] / w[n - k]);
  const rets = [];
  for (let j = n - 11; j <= n; j++) rets.push(Math.log(w[j] / w[j - 1]));
  return [r(1), r(3), r(6), r(12), stdev(rets), (rsi(w, 14) - 50) / 50, w[n] / sma(w, 24) - 1];
}

export function buildDataset(closes) {
  const X = []; const y = [];
  for (let i = WINDOW - 1; i < closes.length - 1; i++) { X.push(features(closes, i)); y.push(closes[i + 1] > closes[i] ? 1 : 0); }
  return { X, y };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function trainLogReg(X, y, { iters = 300, lr = 0.1, l2 = 0.01 } = {}) {
  const d = X[0].length; const n = X.length;
  const mean = Array(d).fill(0); const sd = Array(d).fill(0);
  for (const x of X) x.forEach((v, j) => { mean[j] += v / n; });
  for (const x of X) x.forEach((v, j) => { sd[j] += (v - mean[j]) ** 2 / n; });
  sd.forEach((v, j) => { sd[j] = Math.sqrt(v) || 1; });
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / sd[j]));
  let w = Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(b + Z[i].reduce((s, v, j) => s + v * w[j], 0));
      const e = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    w = w.map((v, j) => v - lr * (gw[j] / n + l2 * v));
    b -= lr * (gb / n);
  }
  return { w, b, mean, sd };
}

export function predictProb(m, x) {
  return sigmoid(m.b + x.reduce((s, v, j) => s + ((v - m.mean[j]) / m.sd[j]) * m.w[j], 0));
}

// Contribución de cada característica a la predicción (explicabilidad básica: coeficiente x valor estandarizado).
export function explain(m, x) {
  return FEATURE_NAMES.map((name, j) => ({ name, contribution: ((x[j] - m.mean[j]) / m.sd[j]) * m.w[j] }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

function evaluate(m, X, y) {
  let ok = 0; let brier = 0;
  X.forEach((x, i) => { const p = predictProb(m, x); if ((p > 0.5 ? 1 : 0) === y[i]) ok++; brier += (p - y[i]) ** 2; });
  const n = X.length;
  const ups = y.reduce((s, v) => s + v, 0) / n;
  const baseline = Math.max(ups, 1 - ups);
  const acc = ok / n;
  const z = (acc - baseline) / Math.sqrt((baseline * (1 - baseline)) / n);
  return { n, acc, baseline, z, brier: brier / n };
}

export function walkForward(closes) {
  const { X, y } = buildDataset(closes);
  if (X.length < 300) throw new Error('Pocos datos para entrenar (se necesitan >= 360 velas)');
  const a = Math.floor(X.length * 0.6); const b = Math.floor(X.length * 0.8);
  const Xtr = X.slice(0, a); const ytr = y.slice(0, a);
  const Xva = X.slice(a, b); const yva = y.slice(a, b);
  const Xte = X.slice(b); const yte = y.slice(b);
  let best = null;
  for (const l2 of [0.001, 0.01, 0.1, 1]) {
    const m = trainLogReg(Xtr, ytr, { l2 });
    const ev = evaluate(m, Xva, yva);
    if (!best || ev.acc > best.val.acc) best = { m, val: ev, l2 };
  }
  const test = evaluate(best.m, Xte, yte);
  const recent = X.slice(-100);
  let worst = { score: 0, feature: FEATURE_NAMES[0] };
  FEATURE_NAMES.forEach((name, j) => {
    const mu = recent.reduce((s, x) => s + x[j], 0) / recent.length;
    const score = Math.abs(mu - best.m.mean[j]) / best.m.sd[j];
    if (score > worst.score) worst = { score, feature: name };
  });
  const tot = best.m.w.reduce((s, v) => s + Math.abs(v), 0) || 1;
  return {
    model: best.m, l2: best.l2,
    metrics: { n_train: Xtr.length, n_val: Xva.length, n_test: Xte.length, acc_val: best.val.acc, acc_test: test.acc,
      baseline_test: test.baseline, z_test: test.z, brier_test: test.brier,
      edge: test.acc - test.baseline > 0.02 && test.z > 2 },
    drift: { score: worst.score, worst_feature: worst.feature },
    importance: FEATURE_NAMES.map((name, j) => ({ name, weight: Math.abs(best.m.w[j]) / tot })).sort((p, q) => q.weight - p.weight),
  };
}
