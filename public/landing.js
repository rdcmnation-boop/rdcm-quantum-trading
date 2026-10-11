// Efectos suaves de la landing: aparición al hacer scroll y brillo que sigue al cursor. Sin datos.
const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 }) : null;
document.querySelectorAll('.rv').forEach((n) => (io ? io.observe(n) : n.classList.add('in')));
document.querySelectorAll('.c').forEach((c) => c.addEventListener('pointermove', (e) => {
  const r = c.getBoundingClientRect();
  c.style.setProperty('--x', `${((e.clientX - r.left) / r.width) * 100}%`);
}));
// Precio: solo se muestra si el dueño lo fijó; si no, sigue diciendo "beta gratis".
fetch('/api/public/plan').then((r) => r.json()).then((p) => {
  const el = document.getElementById('priceline');
  if (el && p && p.price) el.textContent = `Desde $${p.price} al mes, suscripción fija. Sin porcentaje de tus ganancias. Cancela cuando quieras.`;
}).catch(() => {});
