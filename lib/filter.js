// Filtro «¿conviene operar hoy?»: corre ANTES de buscar entradas. Rápido y transparente: devuelve go/no-go y cada razón.
// Funciones puras, sin red. Solo puede VETAR compras nuevas; nunca bloquea ventas ni el cierre de posiciones.
import { stdev } from './indicators.js';

export const DEFAULT_FILTER = Object.freeze({
  newsRiskLevel: 1,        // noticias: nivel de riesgo de esa cripto (news.risk[base]) a partir del cual se veta
  globalNegVeto: true,     // vetar si el mercado entero está en «risk_off» por noticias
  extremeDailyVolPct: 12,  // volatilidad diaria (%) por encima de la cual se veta
  volSpikeRatio: 2.5,      // veta si la volatilidad de las últimas 24 h es ≥ N× la de la semana previa
  expectancyN: 10,         // últimas N operaciones cerradas para medir la expectativa
  expectancyMinPct: -0.3,  // expectativa media por operación (%) por debajo de la cual se veta (con ≥ N operaciones)
  minVolume24Usd: 5e6,     // volumen de 24 h mínimo (USD) de la cripto
  minDepthMultiple: 0,     // (reservado) profundidad mínima del libro ÷ tamaño; 0 = no se evalúa sin datos de libro
  maxSpreadPct: 0.3,       // spread máximo permitido (%) si hay dato de libro
  fundingAbsMax: 0.1,      // funding rate extremo (|%| por 8 h). Solo se evalúa SI se entrega el dato
});

/**
 * tradeFilter({ base, news, hourlyCloses, volume24Usd, recentPct, spreadPct, fundingPct }) → { go, reasons, checks }
 *   hourlyCloses: cierres de 1 h (≥ 192 velas para medir el pico de volatilidad)
 *   volume24Usd: volumen de las últimas 24 h en USD
 *   recentPct: resultados % de las últimas operaciones cerradas de este cliente
 *   fundingPct: funding rate (opcional; no hay fuente verificada en spot, por eso es opcional)
 * Cada chequeo sin dato queda como «no evaluado» y NO bloquea (no se inventan datos); el resumen lo dice.
 */
export function tradeFilter(i, params = {}) {
  const P = { ...DEFAULT_FILTER, ...params };
  const checks = []; const reasons = [];
  const add = (id, label, ok, detail, evaluated = true) => { checks.push({ id, label, ok: !!ok, evaluated, detail }); if (evaluated && !ok) reasons.push(`${label}: ${detail}`); };

  // 1) Noticias
  const base = i.base;
  if (i.news) {
    if (P.globalNegVeto && i.news.risk_off) add('news_global', 'Noticias del mercado', false, 'mercado en freno de riesgo por noticias negativas');
    else if (base && i.news.risk && i.news.risk[base] >= P.newsRiskLevel) add('news_coin', `Noticias de ${base}`, false, 'noticia negativa reciente');
    else add('news', 'Noticias', true, 'sin alertas negativas');
  } else add('news', 'Noticias', true, 'sin datos de noticias', false);

  // 2) Volatilidad realizada extrema
  const cl = i.hourlyCloses || [];
  if (cl.length >= 192) {
    const rets = []; for (let k = 1; k < cl.length; k++) rets.push(cl[k] / cl[k - 1] - 1);
    const last = stdev(rets.slice(-24)); const prev = stdev(rets.slice(-192, -24));
    const dailyPct = last * Math.sqrt(24) * 100; const ratio = prev > 0 ? last / prev : 1;
    add('vol', 'Volatilidad', dailyPct < P.extremeDailyVolPct && ratio < P.volSpikeRatio, `${dailyPct.toFixed(1)} % diaria (límite ${P.extremeDailyVolPct} %), ${ratio.toFixed(1)}× la semana previa (límite ${P.volSpikeRatio}×)`);
  } else add('vol', 'Volatilidad', true, 'pocas velas', false);

  // 3) Expectativa reciente (¿se está agotando la ventaja?)
  const rp = i.recentPct || [];
  if (rp.length >= P.expectancyN) {
    const e = rp.slice(-P.expectancyN).reduce((s, x) => s + x, 0) / P.expectancyN;
    add('expectancy', 'Expectativa reciente', e >= P.expectancyMinPct, `${e.toFixed(2)} % por operación en las últimas ${P.expectancyN} (mínimo ${P.expectancyMinPct} %)`);
  } else add('expectancy', 'Expectativa reciente', true, `solo ${rp.length} operaciones cerradas (se evalúa desde ${P.expectancyN})`, false);

  // 4) Liquidez
  if (Number.isFinite(i.volume24Usd)) add('liquidity', 'Liquidez', i.volume24Usd >= P.minVolume24Usd, `volumen 24 h $${(i.volume24Usd / 1e6).toFixed(1)} M (mínimo $${(P.minVolume24Usd / 1e6).toFixed(0)} M)`);
  else add('liquidity', 'Liquidez', true, 'sin dato de volumen', false);
  if (Number.isFinite(i.spreadPct)) add('spread', 'Spread', i.spreadPct <= P.maxSpreadPct, `${i.spreadPct.toFixed(3)} % (máximo ${P.maxSpreadPct} %)`);

  // 5) Funding (solo con dato)
  if (Number.isFinite(i.fundingPct)) add('funding', 'Funding', Math.abs(i.fundingPct) <= P.fundingAbsMax, `${i.fundingPct.toFixed(3)} % (|máx| ${P.fundingAbsMax} %)`);
  else add('funding', 'Funding', true, 'sin fuente de datos conectada: no evaluado', false);

  const go = reasons.length === 0;
  return { go, reasons, checks, summary: go ? `GO (${checks.filter((c) => c.evaluated).length} chequeos, ${checks.filter((c) => !c.evaluated).length} sin dato)` : `NO-GO: ${reasons[0]}` };
}
