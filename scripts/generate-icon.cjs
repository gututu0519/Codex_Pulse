const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** 计算 PNG 数据块的 CRC 校验。 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 组装 PNG 标准数据块。 */
function chunk(type, content) {
  const data = Buffer.concat([Buffer.from(type), content]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(content.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data));
  return Buffer.concat([header, data, crc]);
}

/** 计算像素到心跳折线的距离，生成抗锯齿图标。 */
function lineDistance(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

const size = 256;
const raw = Buffer.alloc(size * (size * 4 + 1));
const points = [[49, 137], [85, 137], [107, 70], [138, 190], [160, 118], [181, 137], [207, 137]];
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const index = y * (size * 4 + 1) + 1 + x * 4;
  const edge = Math.hypot(Math.max(Math.abs(x - 127.5) - 73, 0), Math.max(Math.abs(y - 127.5) - 73, 0)) - 48;
  const alpha = Math.max(0, Math.min(1, -edge));
  let distance = Infinity;
  for (let i = 0; i < points.length - 1; i++) distance = Math.min(distance, lineDistance(x, y, points[i], points[i + 1]));
  const tint = Math.max(Math.max(0, Math.min(1, 5 - distance)), Math.max(0, 1 - distance / 20) * .12);
  const background = [28 + (256 - y) / 24, 33 + (256 - y) / 20, 40 + (256 - y) / 26];
  const accent = [154, 232, 206];
  for (let c = 0; c < 3; c++) raw[index + c] = Math.round(background[c] * (1 - tint) + accent[c] * tint);
  raw[index + 3] = Math.round(alpha * 255);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(__dirname, '../electron/icon.png'), png);
fs.writeFileSync(path.join(__dirname, '../electron/icon.ico'), Buffer.concat([ico, png]));
console.log('Generated Codex Pulse PNG / ICO');
