'use strict';
// Genera build/icon.ico (y los PNG sueltos) sin depender de ImageMagick ni de
// ningun paquete: se dibuja en un buffer RGBA, se codifica el PNG a mano con
// el zlib que ya trae Node, y se arma el contenedor ICO.
//
// El diseño tiene que leerse a 16 px en la barra de tareas, asi que es lo mas
// simple que se banca: cuadrado redondeado en el naranja de Claude y tres
// barras ascendentes, que es lo que la app muestra.
//
//   node scripts/make-icon.cjs

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NARANJA = [217, 119, 87];    // --accent
const OSCURO = [26, 15, 10];       // el mismo que usa .btn.primary para el texto
const TAMANOS = [16, 24, 32, 48, 64, 128, 256];
const SUPER = 4;                   // se dibuja a 4x y se promedia: da los bordes suaves

// --- dibujo ------------------------------------------------------------------

function dibujar(lado) {
  const n = lado * SUPER;
  const px = Buffer.alloc(n * n * 4);          // RGBA, arranca transparente
  const radio = n * 0.22;

  const poner = (x, y, [r, g, b]) => {
    const i = (y * n + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  // Fondo: cuadrado con esquinas redondeadas.
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (dentroDeRedondeado(x, y, n, radio)) poner(x, y, NARANJA);
    }
  }

  // Tres barras ascendentes, centradas.
  //
  // La geometria se calcula en pixeles FINALES y se redondea antes de escalar
  // a la grilla de supersampling. Si no, a 16 px los bordes caen a mitad de
  // pixel y las barras salen lavadas y desparejas.
  const ep = (v) => Math.max(1, Math.round(v * lado)) * SUPER;   // "en pixeles"
  const ancho = ep(0.14);
  const hueco = ep(0.07);
  const total = ancho * 3 + hueco * 2;
  const x0 = Math.round((n - total) / (2 * SUPER)) * SUPER;
  const base = ep(0.78);                        // donde apoyan
  const alturas = [0.30, 0.42, 0.54].map(ep);
  // A tamaños chicos la esquina redondeada de la barra se come el trazo.
  const rBarra = lado >= 32 ? ancho * 0.26 : 0;

  alturas.forEach((alto, i) => {
    const bx = x0 + i * (ancho + hueco);
    const by = base - alto;
    for (let y = Math.floor(by); y < base; y++) {
      for (let x = Math.floor(bx); x < bx + ancho; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (dentroDeRedondeadoRect(x, y, bx, by, ancho, alto, rBarra)) poner(x, y, OSCURO);
      }
    }
  });

  return promediar(px, n, lado);
}

function dentroDeRedondeado(x, y, n, r) {
  return dentroDeRedondeadoRect(x, y, 0, 0, n, n, r);
}

// Rectangulo con esquinas redondeadas: adentro salvo que caiga fuera del
// circulo de la esquina correspondiente.
function dentroDeRedondeadoRect(x, y, rx, ry, ancho, alto, r) {
  const px = x + 0.5 - rx;
  const py = y + 0.5 - ry;
  if (px < 0 || py < 0 || px > ancho || py > alto) return false;
  const cx = px < r ? r : (px > ancho - r ? ancho - r : px);
  const cy = py < r ? r : (py > alto - r ? alto - r : py);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// Baja de n*SUPER a n promediando cada bloque: el antialiasing sale de aca.
function promediar(px, n, lado) {
  const out = Buffer.alloc(lado * lado * 4);
  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          const i = ((y * SUPER + sy) * n + (x * SUPER + sx)) * 4;
          const al = px[i + 3] / 255;
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += px[i + 3];
        }
      }
      const muestras = SUPER * SUPER;
      const alfa = a / muestras;
      const peso = alfa > 0 ? (a / 255) : 1;    // color premultiplicado
      const o = (y * lado + x) * 4;
      out[o] = Math.round(r / peso);
      out[o + 1] = Math.round(g / peso);
      out[o + 2] = Math.round(b / peso);
      out[o + 3] = Math.round(alfa);
    }
  }
  return out;
}

// --- PNG ---------------------------------------------------------------------

const TABLA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function trozo(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

function png(rgba, lado) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8;    // 8 bits por canal
  ihdr[9] = 6;    // RGBA
  // Cada scanline lleva adelante su byte de filtro; se usa 0 (sin filtro).
  const crudo = Buffer.alloc(lado * (lado * 4 + 1));
  for (let y = 0; y < lado; y++) {
    crudo[y * (lado * 4 + 1)] = 0;
    rgba.copy(crudo, y * (lado * 4 + 1) + 1, y * lado * 4, (y + 1) * lado * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(crudo, { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO ---------------------------------------------------------------------

// Desde Vista el ICO acepta PNG adentro, asi que no hace falta el BMP con
// mascara AND: cada entrada es el PNG tal cual.
function ico(imagenes) {
  const cabecera = Buffer.alloc(6);
  cabecera.writeUInt16LE(0, 0);
  cabecera.writeUInt16LE(1, 2);                 // 1 = icono
  cabecera.writeUInt16LE(imagenes.length, 4);

  const entradas = [];
  let offset = 6 + imagenes.length * 16;
  for (const { lado, datos } of imagenes) {
    const e = Buffer.alloc(16);
    e[0] = lado >= 256 ? 0 : lado;              // 0 significa 256
    e[1] = lado >= 256 ? 0 : lado;
    e[2] = 0;                                    // colores de la paleta
    e[3] = 0;
    e.writeUInt16LE(1, 4);                       // planos
    e.writeUInt16LE(32, 6);                      // bits por pixel
    e.writeUInt32LE(datos.length, 8);
    e.writeUInt32LE(offset, 12);
    entradas.push(e);
    offset += datos.length;
  }
  return Buffer.concat([cabecera, ...entradas, ...imagenes.map((i) => i.datos)]);
}

// --- salida ------------------------------------------------------------------

const destino = path.join(__dirname, '..', 'build');
fs.mkdirSync(destino, { recursive: true });

const imagenes = TAMANOS.map((lado) => ({ lado, datos: png(dibujar(lado), lado) }));
fs.writeFileSync(path.join(destino, 'icon.ico'), ico(imagenes));

// electron-builder usa el .ico en Windows; el PNG de 256 sirve para Linux y
// para mirarlo a ojo.
const png256 = imagenes.find((i) => i.lado === 256);
fs.writeFileSync(path.join(destino, 'icon.png'), png256.datos);

console.log('build/icon.ico  ->', TAMANOS.join(', '), 'px  ·',
  fs.statSync(path.join(destino, 'icon.ico')).size, 'bytes');
console.log('build/icon.png  -> 256 px ·', png256.datos.length, 'bytes');
