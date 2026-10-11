// Genera un par de llaves Ed25519 EN EL NAVEGADOR del cliente (WebCrypto). La llave privada nunca se envía a ningún servidor
// hasta que el cliente pulsa "Verificar y conectar". Robinhood pide la llave PÚBLICA (base64 de 32 bytes) y devuelve una API key.
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };

export async function genEd25519() {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('Tu navegador no permite generar llaves aquí. Usa Safari o Chrome actualizado.');
  let pair;
  try { pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); }
  catch { throw new Error('Tu navegador es muy antiguo para Ed25519. Actualiza Safari o Chrome e inténtalo de nuevo.'); }
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const seed = pkcs8.slice(-32); // en PKCS#8 de Ed25519 la semilla de 32 bytes va al final
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64(pub), privateKey: b64(seed) };
}
