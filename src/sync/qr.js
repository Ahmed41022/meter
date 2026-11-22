/**
 * A QR code encoder, hand-written so pairing needs no vendored library. Pure
 * functions, no DOM: `encodeQr` gives a boolean matrix and `qrSvg` draws it.
 *
 * Scope is deliberately narrow, because that is what keeps it checkable: byte
 * mode only (the join link is one UTF-8 string), error-correction levels L, M,
 * Q and H, versions 1 to 40, and the smallest version that fits is chosen
 * automatically. Layout, Reed-Solomon and the mask rules follow ISO/IEC 18004.
 *
 * Why it is safe to trust a hand-written encoder: a QR code that looks right but
 * does not scan fails silently at the worst moment, so the tests check the
 * codewords (zero Reed-Solomon syndromes per block), both BCH-protected
 * format/version fields and the fixed patterns, and the encoder was also
 * decoded with independent decoders (zxing-cpp, jsQR) for every version and level.
 */

const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
export const ECC_LEVELS = Object.keys(ECC_BITS);
export const MAX_VERSION = 40;

// Per version 1..40 (index 0 unused): error-correction codewords per block and
// the number of blocks, from the ISO/IEC 18004 capacity tables.
const ECC_PER_BLOCK = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

export class QrError extends Error {
  constructor(message) {
    super(message);
    this.name = "QrError";
  }
}

const sizeOf = (version) => version * 4 + 17;
const countBits = (version) => (version <= 9 ? 8 : 16);

/** Alignment pattern centre coordinates (empty for version 1). */
function alignmentPositions(version) {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = sizeOf(version) - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** Calls `fn(cx, cy)` for every alignment pattern; the three that would overlap a finder are skipped. */
function eachAlignment(version, fn) {
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  pos.forEach((cx, i) => pos.forEach((cy, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    fn(cx, cy);
  }));
}

/** Modules left for data and error correction once function patterns are out. */
function rawDataModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const a = Math.floor(version / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

/** How a version at a level splits into Reed-Solomon blocks. */
export function blockLayout(version, ecc) {
  const raw = Math.floor(rawDataModules(version) / 8);
  const blocks = BLOCKS[ecc][version];
  const eccLen = ECC_PER_BLOCK[ecc][version];
  return {
    blocks, eccLen, rawCodewords: raw,
    dataCodewords: raw - blocks * eccLen,
    shortBlocks: blocks - (raw % blocks),
    shortLen: Math.floor(raw / blocks),
  };
}

/** The largest byte count that fits a version at a level. */
export function byteCapacity(version, ecc) {
  const bits = blockLayout(version, ecc).dataCodewords * 8;
  return Math.floor((bits - 4 - countBits(version)) / 8);
}

// ------------------------------------------------------------ Reed-Solomon

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field polynomial x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of the given degree, leading 1 omitted, highest first. */
function generator(degree) {
  const g = new Array(degree).fill(0);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = gmul(g[j], root);
      if (j + 1 < degree) g[j] ^= g[j + 1];
    }
    root = gmul(root, 2);
  }
  return g;
}

export function rsRemainder(data, degree) {
  const gen = generator(degree);
  const rem = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gmul(gen[i], factor);
  }
  return rem;
}

// -------------------------------------------------------------- bit stream

function dataCodewords(bytes, version, ecc) {
  const cap = blockLayout(version, ecc).dataCodewords * 8;
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add error correction to each, and interleave. */
function interleave(data, version, ecc) {
  const { blocks, eccLen, shortBlocks, shortLen } = blockLayout(version, ecc);
  const parts = [];
  let k = 0;
  for (let i = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const block = dat.concat(rsRemainder(dat, eccLen));
    if (i < shortBlocks) block.splice(dat.length, 0, null); // lines short blocks up with long ones
    parts.push(block);
  }
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    for (const block of parts) if (block[i] !== null) out.push(block[i]);
  }
  return out;
}

// ------------------------------------------------------------------ layout

const grid = (n, v) => Array.from({ length: n }, () => new Array(n).fill(v));

/** Which modules are fixed patterns (not data), as a boolean matrix. */
export function functionModules(version) {
  const n = sizeOf(version);
  const f = grid(n, false);
  const rect = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y][x] = true;
  };
  rect(0, 6, n, 1);
  rect(6, 0, 1, n);
  rect(0, 0, 9, 9);
  rect(n - 8, 0, 8, 9);
  rect(0, n - 8, 9, 8);
  eachAlignment(version, (cx, cy) => rect(cx - 2, cy - 2, 5, 5));
  if (version >= 7) {
    rect(n - 11, 0, 3, 6);
    rect(0, n - 11, 6, 3);
  }
  return f;
}

function drawFunctionPatterns(m, version) {
  const n = sizeOf(version);
  for (let i = 0; i < n; i++) {
    m[i][6] = i % 2 === 0;
    m[6][i] = i % 2 === 0;
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) m[y][x] = d !== 2 && d !== 4;
      }
    }
  };
  finder(3, 3);
  finder(n - 4, 3);
  finder(3, n - 4);
  eachAlignment(version, (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) m[cy + dy][cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
    }
  });
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = n - 11 + (i % 3), b = Math.floor(i / 3);
      m[b][a] = dark;
      m[a][b] = dark;
    }
  }
}

/** The 18 version-information bits (6 data bits plus a BCH(18,6) remainder). */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** The 15 format bits (ECC level and mask, BCH protected, XOR 0x5412). */
export function formatBits(ecc, mask) {
  const data = (ECC_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(m, ecc, mask) {
  const n = m.length;
  const bits = formatBits(ecc, mask);
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][n - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[n - 15 + i][8] = bit(i);
  m[n - 8][8] = true; // the always-dark module
}

function placeData(m, isFn, codewords) {
  const n = m.length;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? n - 1 - vert : vert;
        if (!isFn[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

export const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, isFn, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) if (!isFn[y][x] && fn(x, y)) m[y][x] = !m[y][x];
  }
}

/** The four penalty rules of ISO/IEC 18004 section 7.8.3; lower is better. */
export function penalty(m) {
  const n = m.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5); // rule 1: runs of one colour
      run = 1;
    }
    // rule 3: dark-light-dark-dark-dark-light-dark with 4 light modules on a side
    for (let i = 0; i + 7 <= n; i++) {
      if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6)) {
        const before = i >= 4 && [1, 2, 3, 4].every((d) => !get(i - d));
        const after = i + 11 <= n && [7, 8, 9, 10].every((d) => !get(i + d));
        if (before) score += 40;
        if (after) score += 40;
      }
    }
  };
  let dark = 0;
  for (let a = 0; a < n; a++) {
    line((i) => m[a][i]);
    line((i) => m[i][a]);
    for (let b = 0; b < n; b++) {
      if (m[a][b]) dark++;
      if (a + 1 < n && b + 1 < n && m[a][b] === m[a][b + 1] && m[a][b] === m[a + 1][b] && m[a][b] === m[a + 1][b + 1]) score += 3; // rule 2
    }
  }
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10; // rule 4: dark balance
  return score;
}

// ------------------------------------------------------------------- public

/**
 * Encode `text` (as UTF-8 bytes) into a QR matrix. Picks the smallest version
 * that fits and the lowest-penalty mask (the first one wins a tie, so the result
 * is deterministic). Throws `QrError` when the text does not fit version 40.
 *
 * Returns `{ size, modules, version, ecc, mask }`; `modules[y][x]` is true for a
 * dark module.
 */
export function encodeQr(text, { ecc = "M" } = {}) {
  if (!(ecc in ECC_BITS)) throw new QrError(`unknown error-correction level "${ecc}" (use L, M, Q or H)`);
  const bytes = new TextEncoder().encode(String(text));
  let version = 1;
  while (version <= MAX_VERSION && byteCapacity(version, ecc) < bytes.length) version++;
  if (version > MAX_VERSION) {
    throw new QrError(`text is too long for a QR code: ${bytes.length} bytes, at most ${byteCapacity(MAX_VERSION, ecc)} fit at level ${ecc}`);
  }
  const codewords = interleave(dataCodewords(bytes, version, ecc), version, ecc);
  const n = sizeOf(version);
  const isFn = functionModules(version);
  const base = grid(n, false);
  drawFunctionPatterns(base, version);
  placeData(base, isFn, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row) => row.slice());
    applyMask(m, isFn, mask);
    drawFormat(m, ecc, mask);
    const p = penalty(m);
    if (!best || p < best.p) best = { p, mask, m };
  }
  return { size: n, modules: best.m, version, ecc, mask: best.mask };
}

/**
 * The QR code as an SVG string. One `<path>` keeps the DOM small, and the colours
 * are fixed black on white whatever the theme: a QR code needs the contrast, and
 * an inverted code on a dark theme will not scan on many phones. `scale` (pixels
 * per module) sets an explicit width and height; without it the SVG scales to fit.
 */
export function qrSvg(text, { ecc = "M", quiet = 4, scale, label = "QR code" } = {}) {
  const { size, modules } = encodeQr(text, { ecc });
  const total = size + 2 * quiet;
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      let end = x;
      while (end + 1 < size && modules[y][end + 1]) end++; // merge a horizontal run into one segment
      const w = end - x + 1;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x = end;
    }
  }
  const dims = scale ? ` width="${total * scale}" height="${total * scale}"` : "";
  const esc = String(label).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${dims} role="img" aria-label="${esc}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
