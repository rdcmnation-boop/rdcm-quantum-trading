// Página de estado: solo lectura de /api/ready (sin datos internos).
(async () => {
  const s = document.getElementById('s'); const d = document.getElementById('d');
  try {
    const r = await fetch('/api/ready', { cache: 'no-store' }); const j = await r.json().catch(() => ({}));
    const ok = r.ok && j.status === 'ready';
    s.innerHTML = `<span class="dot ${ok ? 'ok' : 'bad'}"></span><b>${ok ? 'Operativo' : 'No disponible'}</b>`;
    d.textContent = `Comprobado ${new Date().toLocaleString()}${ok ? '' : ' · la base de datos o el arranque no están listos'}`;
  } catch { s.innerHTML = '<span class="dot bad"></span><b>No disponible</b>'; d.textContent = 'No se pudo contactar al servidor.'; }
})();
