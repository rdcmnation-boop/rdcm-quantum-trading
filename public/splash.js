// Entrada: el logo se dibuja al centro con un efecto de energía y luego se abre la página. Una vez por sesión.
(() => {
  let seen = false; try { seen = sessionStorage.getItem('qt_splash') === '1'; sessionStorage.setItem('qt_splash', '1'); } catch { /* sin almacenamiento */ }
  if (seen) return;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/splash.css'; document.head.appendChild(l);
  const d = document.createElement('div'); d.id = 'qsplash'; d.setAttribute('data-notr', ''); d.setAttribute('aria-hidden', 'true');
  d.innerHTML = `<div class="grid"></div><svg viewBox="0 0 200 200"><defs><linearGradient id="qg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1a8"/><stop offset=".5" stop-color="#ffd60a"/><stop offset="1" stop-color="#ff9f0a"/></linearGradient></defs>
    <polygon class="ring" points="100,8 180,54 180,146 100,192 20,146 20,54" fill="none"/>
    <circle class="ring ring2" cx="100" cy="100" r="64"/>
    <path class="qq" d="M100 62a38 38 0 1 0 0 76a38 38 0 1 0 0-76"/>
    <path class="arrow" d="M96 124l16-16l10 10l22-26M138 92h-12M138 92v12"/></svg>
    <div class="nm">QUANTUM</div><div class="sb">RDCMNATION</div><div class="bar"><i></i></div>`;
  document.documentElement.appendChild(d);
  const go = () => { d.classList.add('out'); setTimeout(() => d.remove(), 800); };
  const t0 = Date.now(); const minMs = 2900;
  const fin = () => setTimeout(go, Math.max(0, minMs - (Date.now() - t0)));
  if (document.readyState === 'complete') fin(); else addEventListener('load', fin);
  d.addEventListener('click', go); setTimeout(go, 6000);
})();
