// Exportación del Cerebro y del estado del app (código + configuración + modelos + reglas), sin secretos ni datos de clientes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SOURCE_DIRS = ['lib', 'bot', 'public', 'tests'];
const SOURCE_ROOT = ['package.json', 'render.yaml', 'server.js', 'README.md', '.env.example', '.gitignore'];

function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad)]);
}

export function buildTarGz(files) {
  const parts = files.map((f) => tarEntry(f.name, Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

export function collectSource(root) {
  const out = [];
  for (const f of SOURCE_ROOT) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) out.push({ name: `quantum-trading/${f}`, data: fs.readFileSync(p) });
  }
  for (const d of SOURCE_DIRS) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) out.push({ name: `quantum-trading/${d}/${f}`, data: fs.readFileSync(p) });
    }
  }
  return out;
}
