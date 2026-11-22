/**
 * The QR encoder is checked without a decoder in the repo: the codewords are read
 * back out of the matrix and must have zero Reed-Solomon syndromes in every
 * block, the BCH-protected format and version fields must be valid, and the fixed
 * patterns must sit where ISO/IEC 18004 puts them. (It was also decoded with
 * zxing-cpp for every version and level (and jsQR for all but 23-L, which jsQR
 * itself cannot read) while writing it; those are not
 * dependencies, so that check is not repeated here.)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  ECC_LEVELS, MASKS, MAX_VERSION, QrError, blockLayout, byteCapacity, encodeQr, formatBits,
  functionModules, penalty, qrSvg, rsRemainder, versionBits,
} from "../src/sync/qr.js";
import { encodeJoin, joinLink } from "../src/sync/codes.js";

const filler = (n, seed = 1) => Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7 + seed) % 90))).join("");

const joinInfo = {
  host: "meter-relay.example.workers.dev",
  vaultId: `${"0123456789abcdef".repeat(2)}.fedcba9876543210`,
  joinId: "00ff00ff00ff00ff",
  secret: Uint8Array.from({ length: 16 }, (_, i) => 200 - i),
};
const LINK = joinLink("https://ahmed41022.github.io/meter/", joinInfo);

// ---- an independent reader, written from the standard, not from qr.js ----

// GF(256) with the QR polynomial, by shift-and-add so it shares nothing with the log tables.
function gmul(a, b) {
  let r = 0;
  for (; b; b >>= 1) {
    if (b & 1) r ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return r;
}
const gpow2 = (k) => { let r = 1; for (let i = 0; i < k; i++) r = gmul(r, 2); return r; };

/** Evaluate a codeword block (highest degree first) at 2^k. */
function syndrome(block, k) {
  const x = gpow2(k);
  return block.reduce((acc, c) => gmul(acc, x) ^ c, 0);
}

/** The interleaved codewords as placed in the symbol, after removing the mask. */
function readCodewords(q) {
  const { modules, size, version, mask } = q;
  const isFn = functionModules(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (isFn[y][x]) continue;
        bits.push(modules[y][x] !== MASKS[mask](x, y));
      }
    }
  }
  const { rawCodewords } = blockLayout(version, q.ecc);
  const out = [];
  for (let i = 0; i < rawCodewords; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i * 8 + k] ? 1 : 0);
    out.push(b);
  }
  return out;
}

/** Undo the interleaving: one array per block, data then error correction. */
function deinterleave(codewords, version, ecc) {
  const { blocks, eccLen, shortBlocks, shortLen } = blockLayout(version, ecc);
  const dataLen = (i) => shortLen - eccLen + (i < shortBlocks ? 0 : 1);
  const parts = Array.from({ length: blocks }, () => []);
  let k = 0;
  for (let i = 0; i < dataLen(blocks - 1); i++) {
    for (let b = 0; b < blocks; b++) if (i < dataLen(b)) parts[b].push(codewords[k++]);
  }
  for (let i = 0; i < eccLen; i++) for (let b = 0; b < blocks; b++) parts[b].push(codewords[k++]);
  expect(k).toBe(codewords.length);
  return parts;
}

/** Decode the byte-mode payload from the data codewords. */
function payloadOf(q) {
  const parts = deinterleave(readCodewords(q), q.version, q.ecc);
  const { eccLen } = blockLayout(q.version, q.ecc);
  const data = parts.flatMap((p) => p.slice(0, p.length - eccLen));
  const bits = data.map((b) => b.toString(2).padStart(8, "0")).join("");
  expect(bits.slice(0, 4)).toBe("0100");
  const cb = q.version <= 9 ? 8 : 16;
  const len = parseInt(bits.slice(4, 4 + cb), 2);
  const out = [];
  for (let i = 0; i < len; i++) out.push(parseInt(bits.slice(4 + cb + i * 8, 12 + cb + i * 8), 2));
  return new TextDecoder().decode(Uint8Array.from(out));
}

const bchRemainder = (value, poly, degree) => {
  let r = value;
  for (let i = 31 - Math.clz32(value); i >= degree; i--) if ((r >>> i) & 1) r ^= poly << (i - degree);
  return r;
};

function readBits(m, cells) {
  return cells.reduce((acc, [x, y], i) => acc | ((m[y][x] ? 1 : 0) << i), 0);
}

// ------------------------------------------------------------------ tests

describe("Reed-Solomon", () => {
  it("matches the published vector for 1-M (the HELLO WORLD walkthrough)", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
});

describe("encodeQr structure", () => {
  const cases = [
    ["HELLO WORLD", "M"],
    ["A", "M"],
    ["A", "L"],
    ["A", "Q"],
    ["A", "H"],
    [LINK, "M"],
    [LINK, "H"],
    [filler(300), "M"],
    [filler(300), "L"],
    [filler(900, 5), "Q"],
    [filler(120), "H"],
    ["café ✓ \u{1F600}", "M"],
  ];

  it.each(cases)("%s at %s is internally consistent", (text, ecc) => {
    const q = encodeQr(text, { ecc });
    const { modules, size, version } = q;
    expect(size).toBe(version * 4 + 17);
    expect(modules).toHaveLength(size);
    expect(modules.every((r) => r.length === size && r.every((b) => typeof b === "boolean"))).toBe(true);

    // the payload comes back out, and every block's error-correction is valid
    expect(payloadOf(q)).toBe(text);
    const parts = deinterleave(readCodewords(q), version, ecc);
    const { eccLen } = blockLayout(version, ecc);
    for (const block of parts) for (let k = 0; k < eccLen; k++) expect(syndrome(block, k)).toBe(0);
  });

  it("puts the finders, timing and the dark module where the standard does", () => {
    for (const v of [1, 2, 7, 15, 21]) {
      const { modules: m, size: n } = forceVersion(v);
      const finder = (x0, y0) => {
        for (let dy = 0; dy < 7; dy++) {
          for (let dx = 0; dx < 7; dx++) {
            const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
            expect(m[y0 + dy][x0 + dx]).toBe(ring !== 2);
          }
        }
      };
      finder(0, 0);
      finder(n - 7, 0);
      finder(0, n - 7);
      for (let i = 8; i < n - 8; i++) {
        expect(m[6][i]).toBe(i % 2 === 0);
        expect(m[i][6]).toBe(i % 2 === 0);
      }
      expect(m[n - 8][8]).toBe(true);
      // the separators around each finder are light
      for (let i = 0; i < 8; i++) {
        expect(m[7][i]).toBe(false);
        expect(m[i][7]).toBe(false);
        expect(m[7][n - 1 - i]).toBe(false);
        expect(m[i][n - 8]).toBe(false);
        expect(m[n - 8][i]).toBe(false);
        expect(m[n - 1 - i][7]).toBe(false);
      }
    }
  });

  it("draws alignment patterns at the standard centres", () => {
    const centres = { 2: [6, 18], 7: [6, 22, 38], 10: [6, 28, 50], 15: [6, 26, 48, 70], 32: [6, 34, 60, 86, 112, 138] };
    for (const [v, pos] of Object.entries(centres)) {
      const { modules: m } = forceVersion(Number(v));
      const last = pos.length - 1;
      pos.forEach((cx, i) => pos.forEach((cy, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) expect(m[cy + dy][cx + dx]).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }));
    }
  });

  it("writes valid, matching format bits in both places", () => {
    for (const ecc of ECC_LEVELS) {
      const q = encodeQr(LINK, { ecc });
      const m = q.modules, n = q.size;
      const first = readBits(m, [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
        [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
      ]);
      const second = readBits(m, [
        ...Array.from({ length: 8 }, (_, i) => [n - 1 - i, 8]),
        ...Array.from({ length: 7 }, (_, i) => [8, n - 7 + i]),
      ]);
      expect(first).toBe(second);
      expect(first).toBe(formatBits(ecc, q.mask));
      expect(bchRemainder(first ^ 0x5412, 0x537, 10)).toBe(0); // a valid BCH(15,5) word
      expect(((first ^ 0x5412) >>> 13) & 3).toBe({ L: 1, M: 0, Q: 3, H: 2 }[ecc]);
      expect(((first ^ 0x5412) >>> 10) & 7).toBe(q.mask);
    }
  });

  it("writes valid version information, twice, from version 7 up and not before", () => {
    for (const v of [7, 8, 14, 15, 22, 40]) {
      const { modules: m, size: n } = forceVersion(v);
      const a = readBits(m, Array.from({ length: 18 }, (_, i) => [n - 11 + (i % 3), Math.floor(i / 3)]));
      const b = readBits(m, Array.from({ length: 18 }, (_, i) => [Math.floor(i / 3), n - 11 + (i % 3)]));
      expect(a).toBe(b);
      expect(a).toBe(versionBits(v));
      expect(a >>> 12).toBe(v);
      expect(bchRemainder(a, 0x1f25, 12)).toBe(0);
    }
    expect(versionBits(7)).toBe(0x07c94); // the value printed in the standard's table
    expect(versionBits(40)).toBe(0x28c69);
    // version 6 has no version field: that corner holds data
    const v6 = forceVersion(6);
    expect(functionModules(6)[0][v6.size - 11]).toBe(false);
  });
});

describe("encodeQr choices", () => {
  it("builds a real join link and reports its size", () => {
    expect(LINK).toBe(`https://ahmed41022.github.io/meter/#join=${encodeJoin(joinInfo, { grouped: false })}`);
    expect(LINK.length).toBeGreaterThan(150);
    expect(LINK.length).toBeLessThan(190);
    const q = encodeQr(LINK, { ecc: "M" });
    expect(q.version).toBeLessThanOrEqual(10);
    expect(q.size).toBe(q.version * 4 + 17);
    expect(q.version).toBe(forceVersionFor(LINK.length, "M"));
  });

  it("uses ecc M by default", () => {
    expect(encodeQr(LINK)).toEqual(encodeQr(LINK, { ecc: "M" }));
  });

  it("forces a high version for a long string", () => {
    const q = encodeQr(filler(300), { ecc: "M" });
    expect(q.version).toBeGreaterThanOrEqual(10);
    expect(payloadOf(q)).toBe(filler(300));
  });

  it("matches the standard's byte capacities", () => {
    const known = { 1: [17, 14, 11, 7], 10: [271, 213, 151, 119], 40: [2953, 2331, 1663, 1273] };
    for (const [v, caps] of Object.entries(known)) {
      ECC_LEVELS.forEach((ecc, i) => expect(byteCapacity(Number(v), ecc)).toBe(caps[i]));
    }
  });

  it("switches version exactly at each capacity boundary, at every level", () => {
    for (const ecc of ECC_LEVELS) {
      for (const v of [...Array.from({ length: 15 }, (_, i) => i + 1), 24, MAX_VERSION]) {
        const cap = byteCapacity(v, ecc);
        expect(encodeQr(filler(cap), { ecc }).version).toBe(v);
        if (v < MAX_VERSION) expect(encodeQr(filler(cap + 1), { ecc }).version).toBe(v + 1);
      }
    }
  });

  it("counts UTF-8 bytes, not characters", () => {
    const text = "é".repeat(10); // 20 bytes
    expect(encodeQr(text, { ecc: "L" }).version).toBe(encodeQr(filler(20), { ecc: "L" }).version);
    expect(payloadOf(encodeQr(text, { ecc: "L" }))).toBe(text);
  });

  it("throws a clear error when the text is too long or the level is unknown", () => {
    expect(() => encodeQr(filler(2954), { ecc: "L" })).toThrow(QrError);
    expect(() => encodeQr(filler(2954), { ecc: "L" })).toThrow(/too long.*2954 bytes.*2953/);
    expect(() => encodeQr(filler(1274), { ecc: "H" })).toThrow(/too long/);
    expect(() => encodeQr("x", { ecc: "Z" })).toThrow(/error-correction level/);
    expect(() => encodeQr(filler(2953), { ecc: "L" })).not.toThrow();
  });

  it("encodes the empty string as version 1", () => {
    const q = encodeQr("");
    expect(q.version).toBe(1);
    expect(payloadOf(q)).toBe("");
  });
});

describe("mask choice", () => {
  it("is deterministic", () => {
    const a = encodeQr(LINK, { ecc: "Q" });
    const b = encodeQr(LINK, { ecc: "Q" });
    expect(a.mask).toBe(b.mask);
    expect(a.modules).toEqual(b.modules);
  });

  it("picks the mask with the lowest penalty (first wins a tie)", () => {
    for (const text of [LINK, "HELLO WORLD", filler(200, 3)]) {
      const q = encodeQr(text, { ecc: "M" });
      const isFn = functionModules(q.version);
      const scores = MASKS.map((_, mask) => {
        // re-mask the chosen symbol: undo its mask, apply `mask`, redraw the format bits
        const m = q.modules.map((row, y) => row.map((b, x) => (isFn[y][x] ? b : b !== MASKS[q.mask](x, y) !== MASKS[mask](x, y))));
        const n = q.size;
        const bits = formatBits("M", mask);
        const bit = (i) => ((bits >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
        m[7][8] = bit(6);
        m[8][8] = bit(7);
        m[8][7] = bit(8);
        for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
        for (let i = 0; i < 8; i++) m[8][n - 1 - i] = bit(i);
        for (let i = 8; i < 15; i++) m[n - 15 + i][8] = bit(i);
        return penalty(m);
      });
      expect(q.mask).toBe(scores.indexOf(Math.min(...scores)));
    }
  });

  it("scores the textbook penalty cases", () => {
    const blank = Array.from({ length: 21 }, () => new Array(21).fill(false));
    // 42 lines of a 21-long run (3 + 16 each), 400 blocks of 3, and a 0% dark balance (90)
    expect(penalty(blank)).toBe(42 * 19 + 400 * 3 + 90);
  });
});

describe("qrSvg", () => {
  const parse = (svg) => new DOMParser().parseFromString(svg, "image/svg+xml");

  it("is a well-formed SVG sized for the symbol plus its quiet zone", () => {
    const q = encodeQr(LINK);
    const doc = parse(qrSvg(LINK));
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    const svg = doc.documentElement;
    expect(svg.tagName).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${q.size + 8} ${q.size + 8}`);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("QR code");
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(svg.hasAttribute("width")).toBe(false);
  });

  it("uses a custom quiet zone, scale and label", () => {
    const q = encodeQr("hi");
    const svg = parse(qrSvg("hi", { quiet: 2, scale: 5, label: 'Join "Meter" & <go>' })).documentElement;
    const total = q.size + 4;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${total} ${total}`);
    expect(svg.getAttribute("width")).toBe(String(total * 5));
    expect(svg.getAttribute("height")).toBe(String(total * 5));
    expect(svg.getAttribute("aria-label")).toBe('Join "Meter" & <go>');
  });

  it("is black on white with one path, whatever the theme", () => {
    const svg = parse(qrSvg(LINK)).documentElement;
    const rects = svg.getElementsByTagName("rect");
    const paths = svg.getElementsByTagName("path");
    expect(paths).toHaveLength(1);
    expect(rects).toHaveLength(1);
    expect(rects[0].getAttribute("fill")).toBe("#fff");
    expect(paths[0].getAttribute("fill")).toBe("#000");
    expect(svg.querySelector("[style], style, [class]")).toBeNull();
  });

  it("draws exactly the dark modules of the matrix", () => {
    for (const quiet of [4, 1]) {
      const q = encodeQr(LINK, { ecc: "Q" });
      const d = parse(qrSvg(LINK, { ecc: "Q", quiet })).getElementsByTagName("path")[0].getAttribute("d");
      const drawn = Array.from({ length: q.size }, () => new Array(q.size).fill(false));
      for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
        for (let i = 0; i < Number(m[3]); i++) drawn[Number(m[2]) - quiet][Number(m[1]) - quiet + i] = true;
      }
      expect(drawn).toEqual(q.modules);
      expect(d.replace(/M\d+ \d+h\d+v1h-\d+z/g, "")).toBe("");
    }
  });

  it("passes encoding errors through", () => {
    expect(() => qrSvg(filler(3000), { ecc: "L" })).toThrow(QrError);
  });
});

// ---------------------------------------------------------------- helpers

/** The smallest version whose capacity fits `bytes`. */
function forceVersionFor(bytes, ecc) {
  let v = 1;
  while (byteCapacity(v, ecc) < bytes) v++;
  return v;
}

/** A symbol of exactly version `v` (level L), by sizing the text to just fit it. */
function forceVersion(v) {
  const q = encodeQr(filler(v === 1 ? 5 : byteCapacity(v - 1, "L") + 1), { ecc: "L" });
  expect(q.version).toBe(v);
  return q;
}
