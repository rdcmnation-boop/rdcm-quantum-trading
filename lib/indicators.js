// Indicadores técnicos clásicos (funciones puras). Se incluyen tal cual en el bot descargable.

export function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

// EMA alineada al final de la serie (longitud = arr.length - n + 1).
export function ema(arr, n) {
  if (arr.length < n) return [];
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const out = [e];
  for (let i = n; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}

// RSI de Wilder.
export function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(0, d)) / n;
    loss = (loss * (n - 1) + Math.max(0, -d)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  if (!es.length) return null;
  const line = es.map((v, i) => ef[ef.length - es.length + i] - v);
  const signal = ema(line, sig);
  if (signal.length < 2) return null;
  const L = line.length;
  return { macd: line[L - 1], signal: signal[signal.length - 1], prevMacd: line[L - 2],
    prevSignal: signal[signal.length - 2], hist: line[L - 1] - signal[signal.length - 1] };
}

export function bollinger(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  const mean = w.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(w.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  const upper = mean + k * sd;
  const lower = mean - k * sd;
  return { mean, upper, lower, pctB: upper === lower ? 0.5 : (closes[closes.length - 1] - lower) / (upper - lower) };
}

export function stdev(arr) {
  if (!arr.length) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
