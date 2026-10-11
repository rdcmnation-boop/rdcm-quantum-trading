// Seguridad: contraseñas, sesiones firmadas, cifrado de llaves, TOTP (2FA), límite de intentos.
// Solo usa node:crypto (cero dependencias).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// ---------- Contraseñas (scrypt + sal única) ----------
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, SCRYPT);
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  try {
    const [v, s, h] = String(stored).split('$');
    if (v !== 's1') return false;
    const salt = Buffer.from(s, 'base64');
    const expected = Buffer.from(h, 'base64');
    const got = await scrypt(pw, salt, 64, SCRYPT);
    return crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

// ---------- Sesiones: token firmado con HMAC (cookie httpOnly) ----------
export function signSession(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readSession(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEq(sig || '', good)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// ---------- Cifrado de llaves API (AES-256-GCM) ----------
function keyFrom(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encrypt(secret, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(secret, blob) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('formato de cifrado desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ---------- TOTP (RFC 6238) para 2FA del dueño ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function b32enc(buf) {
  let bits = '';
  let out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

export function b32dec(s) {
  let bits = '';
  for (const c of String(s).replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('base32 inválido');
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function newTotpSecret() {
  return b32enc(crypto.randomBytes(20));
}

export function totp(secretB32, t = Date.now(), digits = 6) {
  const ctr = Math.floor(t / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(ctr));
  const h = crypto.createHmac('sha1', b32dec(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

export function verifyTotp(secret, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  let ok = false;
  for (const d of [-1, 0, 1]) if (safeEq(totp(secret, Date.now() + d * 30000), c)) ok = true;
  return ok;
}

// ---------- Límite de intentos en memoria ----------
export function createLimiter() {
  const m = new Map();
  return function allow(key, max, windowMs) {
    const now = Date.now();
    const e = m.get(key);
    if (!e || e.reset < now) {
      m.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    e.n += 1;
    return e.n <= max;
  };
}
