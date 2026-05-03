const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const outPath = path.resolve(__dirname, '..', 'extension', 'media', 'icon.png');
const size = 256;
const scale = 4;
const w = size * scale;
const h = size * scale;
const pixels = new Uint8ClampedArray(w * h * 4);

function hex(value) {
  const clean = value.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
    clean.length >= 8 ? parseInt(clean.slice(6, 8), 16) : 255,
  ];
}

function blendPixel(x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (Math.floor(y) * w + Math.floor(x)) * 4;
  const a = Math.max(0, Math.min(1, alpha * color[3] / 255));
  const inv = 1 - a;
  pixels[i] = color[0] * a + pixels[i] * inv;
  pixels[i + 1] = color[1] * a + pixels[i + 1] * inv;
  pixels[i + 2] = color[2] * a + pixels[i + 2] * inv;
  pixels[i + 3] = 255;
}

function fill(color) {
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) blendPixel(x, y, color, 1);
  }
}

function roundedRect(x, y, width, height, radius, color) {
  x *= scale; y *= scale; width *= scale; height *= scale; radius *= scale;
  const x2 = x + width;
  const y2 = y + height;
  for (let py = Math.floor(y); py < Math.ceil(y2); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(x2); px += 1) {
      const cx = Math.max(x + radius, Math.min(px + 0.5, x2 - radius));
      const cy = Math.max(y + radius, Math.min(py + 0.5, y2 - radius));
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
      if (d <= radius + 0.5) blendPixel(px, py, color, Math.min(1, radius + 0.5 - d));
    }
  }
}

function circle(cx, cy, r, color) {
  cx *= scale; cy *= scale; r *= scale;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r + 0.5) blendPixel(x, y, color, Math.min(1, r + 0.5 - d));
    }
  }
}

function line(x1, y1, x2, y2, width, color) {
  x1 *= scale; y1 *= scale; x2 *= scale; y2 *= scale; width *= scale;
  const minX = Math.floor(Math.min(x1, x2) - width);
  const maxX = Math.ceil(Math.max(x1, x2) + width);
  const minY = Math.floor(Math.min(y1, y2) - width);
  const maxY = Math.ceil(Math.max(y1, y2) + width);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / len2));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
      if (d <= width / 2 + 0.5) blendPixel(x, y, color, Math.min(1, width / 2 + 0.5 - d));
    }
  }
}

function polygon(points, color) {
  const pts = points.map(([x, y]) => [x * scale, y * scale]);
  const ys = pts.map((p) => p[1]);
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));
  for (let y = minY; y <= maxY; y += 1) {
    const nodes = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
        nodes.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
    }
    nodes.sort((a, b) => a - b);
    for (let i = 0; i < nodes.length; i += 2) {
      for (let x = Math.floor(nodes[i]); x < Math.ceil(nodes[i + 1]); x += 1) blendPixel(x, y, color, 1);
    }
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function writePng(filename, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const src = y * width * 4;
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    Buffer.from(rgba.buffer, src, width * 4).copy(raw, dst + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(filename, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

function downsample() {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const i = ((y * scale + sy) * w + x * scale + sx) * 4;
          acc[0] += pixels[i];
          acc[1] += pixels[i + 1];
          acc[2] += pixels[i + 2];
          acc[3] += pixels[i + 3];
        }
      }
      const j = (y * size + x) * 4;
      out[j] = acc[0] / (scale * scale);
      out[j + 1] = acc[1] / (scale * scale);
      out[j + 2] = acc[2] / (scale * scale);
      out[j + 3] = acc[3] / (scale * scale);
    }
  }
  return out;
}

fill(hex('#172231'));

roundedRect(19, 24, 218, 208, 22, hex('#202d3e'));

roundedRect(46, 51, 164, 30, 5, hex('#48d6a2'));
circle(63, 66, 5, hex('#f1fff9'));
line(83, 66, 121, 66, 7, hex('#e9fff7'));

circle(102, 131, 18, hex('#dffbf3'));
circle(120, 116, 22, hex('#dffbf3'));
circle(144, 117, 21, hex('#dffbf3'));
circle(162, 134, 18, hex('#dffbf3'));
roundedRect(100, 127, 64, 31, 15, hex('#dffbf3'));
line(129, 153, 129, 181, 12, hex('#dffbf3'));

line(130, 100, 130, 154, 5, hex('#6ce5bd'));
line(115, 112, 106, 121, 5, hex('#6ce5bd'));
line(106, 121, 118, 130, 5, hex('#6ce5bd'));
line(116, 141, 102, 141, 5, hex('#6ce5bd'));
line(145, 112, 154, 121, 5, hex('#6ce5bd'));
line(154, 121, 142, 130, 5, hex('#6ce5bd'));
line(144, 141, 158, 141, 5, hex('#6ce5bd'));

circle(69, 198, 18, hex('#38d99f'));
circle(129, 198, 18, hex('#48d6a2'));
circle(189, 198, 18, hex('#38d99f'));
line(69, 198, 189, 198, 10, hex('#48d6a2'));

circle(69, 198, 8, hex('#142231'));
circle(129, 198, 8, hex('#142231'));
circle(189, 198, 8, hex('#142231'));

writePng(outPath, size, size, downsample());
console.log(`Wrote ${outPath}`);
