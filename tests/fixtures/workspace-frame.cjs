// Synthetic desktop pixels for a local, unauthenticated RFB test server. This
// is deliberately generated here, rather than bundled as a product demo asset.
const width = 1024, height = 640;
const glyphs = {
  A: ['01110','10001','10001','11111','10001','10001','10001'], B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'], D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'], F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'], H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['111','010','010','010','010','010','111'], J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'], L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'], N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'], P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'], R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'], T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'], V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'], X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'], Z: ['11111','00001','00010','00100','01000','10000','11111'],
  0: ['01110','10001','10011','10101','11001','10001','01110'], 1: ['010','110','010','010','010','010','111'],
  2: ['01110','10001','00001','00010','00100','01000','11111'], 3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['10010','10010','10010','11111','00010','00010','00010'], 5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'], 7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'], 9: ['01110','10001','10001','01111','00001','00001','01110'],
  '.': ['0','0','0','0','0','0','1'], ':': ['0','1','1','0','1','1','0'], '-': ['000','000','000','111','000','000','000'],
  '/': ['00001','00001','00010','00100','01000','10000','10000'], '$': ['00100','01111','10100','01110','00101','11110','00100'],
  '>': ['100','010','001','001','001','010','100'], '@': ['01110','10001','10111','10101','10111','10000','01111'],
};
function workspaceInit() {
  const name = Buffer.from('Isolated desktop - no external connection');
  const bytes = Buffer.alloc(24 + name.length);
  bytes.writeUInt16BE(width, 0); bytes.writeUInt16BE(height, 2);
  bytes[4] = 32; bytes[5] = 24; bytes[7] = 1;
  for (const offset of [8, 10, 12]) bytes.writeUInt16BE(255, offset);
  bytes[14] = 16; bytes[15] = 8;
  bytes.writeUInt32BE(name.length, 20); name.copy(bytes, 24);
  return bytes;
}
let cached;
function workspaceFramebuffer() {
  if (cached) return cached;
  const bytes = Buffer.alloc(16 + width * height * 4);
  bytes.writeUInt16BE(1, 2); bytes.writeUInt16BE(width, 8); bytes.writeUInt16BE(height, 10);
  function pixel(x, y, rgb) {
    const at = 16 + (y * width + x) * 4;
    // noVNC requests little-endian 32-bit pixels with R/G/B shifts 0/8/16.
    bytes[at] = rgb[0]; bytes[at + 1] = rgb[1]; bytes[at + 2] = rgb[2];
  }
  function rect(x, y, w, h, color, radius = 0) {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      const dx = Math.max(x + radius - px, 0, px - (x + w - radius - 1));
      const dy = Math.max(y + radius - py, 0, py - (y + h - radius - 1));
      if (dx * dx + dy * dy <= radius * radius) pixel(px, py, color);
    }
  }
  function text(value, x, y, color, scale = 2) {
    for (const character of value.toUpperCase()) {
      const glyph = glyphs[character];
      if (!glyph) { x += 4 * scale; continue; }
      for (let row = 0; row < 7; row++) for (let col = 0; col < glyph[row].length; col++)
        if (glyph[row][col] === '1') rect(x + col * scale, y + row * scale, scale, scale, color);
      x += (glyph[0].length + 1) * scale;
    }
  }
  // A soft, restrained wallpaper with a bright arc behind the terminal window.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const glow = Math.exp(-((x - 820) ** 2 / 180000 + (y - 150) ** 2 / 120000));
    const blue = Math.exp(-((x - 170) ** 2 / 140000 + (y - 560) ** 2 / 90000));
    const arc = Math.exp(-((Math.hypot(x - 750, y - 460) - 440) ** 2 / 5000));
    pixel(x, y, [14 + glow * 47 + arc * 10, 21 + glow * 31 + blue * 20 + arc * 16, 34 + glow * 40 + blue * 37 + arc * 26]);
  }
  rect(0, 0, width, 34, [18, 22, 30]);
  text('Activities', 20, 11, [186, 194, 209], 1);
  text('Oct 3  00:24', 468, 11, [205, 210, 224], 1);
  text('EN', 955, 11, [154, 167, 188], 1);
  rect(124, 111, 776, 406, [11, 16, 26], 15);
  rect(120, 104, 776, 406, [66, 72, 89], 14);
  rect(121, 105, 774, 404, [20, 26, 37], 13);
  rect(122, 106, 772, 37, [34, 41, 54], 12);
  rect(122, 129, 772, 14, [34, 41, 54]);
  text('studio@ubuntu: ~', 386, 118, [168, 179, 199], 1);
  rect(860, 116, 17, 17, [56, 62, 76], 8); text('X', 866, 121, [173, 185, 206], 1);
  text('UBUNTU 24.04 LTS', 151, 172, [227, 232, 242]);
  text('A quiet place to build.', 151, 205, [119, 135, 160], 1);
  text('studio@ubuntu', 151, 252, [115, 211, 189]);
  text(':~$', 307, 252, [159, 175, 200]);
  text('systemctl status workspace', 351, 252, [200, 210, 226], 1);
  text('WORKSPACE.SERVICE - DEVELOPMENT ENVIRONMENT', 151, 291, [163, 179, 203], 1);
  text('Active: active', 175, 320, [109, 202, 174], 1);
  text('Memory: 128.4M', 175, 345, [148, 163, 187], 1);
  text('Tasks: 12', 175, 370, [148, 163, 187], 1);
  text('studio@ubuntu', 151, 422, [115, 211, 189]); text(':~$', 307, 422, [159, 175, 200]);
  rect(351, 420, 8, 17, [160, 184, 210]);
  text('LOCAL SYNTHETIC DESKTOP - NO EXTERNAL CONNECTION', 325, 609, [121, 139, 166], 1);
  cached = bytes;
  return bytes;
}
module.exports = { workspaceInit, workspaceFramebuffer };
