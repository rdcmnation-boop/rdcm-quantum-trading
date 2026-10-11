// Idioma para páginas estáticas (inicio y legal).
import { initI18n, mountSwitch } from '/i18n.js';
await initI18n();
mountSwitch(document.querySelector('nav.top') || null);
