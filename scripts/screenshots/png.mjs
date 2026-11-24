// @ts-check
// Smaller PNGs without new dependencies: decodes the 8-bit RGB(A) PNG Chrome writes, drops an
// alpha channel that is opaque everywhere, writes a palette when there are at most 256 colours,
// picks each row's filter by the usual minimum-sum heuristic and deflates at the highest level.
// Lossless: the pixels stay exactly as Chrome drew them.
import { crc32, deflateSync, inflateSync, constants } from "node:zlib";

const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/**
 * @param {Buffer} png
 * @returns {{ width: number, height: number, channels: number, pixels: Buffer }}
 */
export function decode(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  /** @type {Buffer[]} */
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] ?? 0 : 0;
      const up = prior ? prior[x] ?? 0 : 0;
      const corner = prior && x >= channels ? prior[x - channels] ?? 0 : 0;
      const value = line[x] ?? 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, corner);
      else if (filter !== 0) throw new Error(`bad filter ${filter}`);
      out[x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** @param {number} a @param {number} b @param {number} c */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** @param {string} type @param {Buffer} body */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * Rows filtered with whichever filter gives the smallest sum of absolute values.
 * @param {Buffer} pixels @param {number} width @param {number} height @param {number} bpp
 * @param {boolean} adaptive
 */
function filtered(pixels, width, height, bpp, adaptive) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    const filters = adaptive ? [0, 1, 2, 3, 4] : [0];
    for (const filter of filters) {
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const value = row[x] ?? 0;
        const left = x >= bpp ? row[x - bpp] ?? 0 : 0;
        const up = prior ? prior[x] ?? 0 : 0;
        const corner = prior && x >= bpp ? prior[x - bpp] ?? 0 : 0;
        const predicted = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0;
        const byte = (value - predicted) & 0xff;
        candidate[x] = byte;
        score += byte < 128 ? byte : 256 - byte;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
        out[y * (stride + 1)] = filter;
        candidate.copy(out, y * (stride + 1) + 1);
      }
    }
    if (best === 0 && !adaptive) {
      out[y * (stride + 1)] = 0;
      row.copy(out, y * (stride + 1) + 1);
    }
  }
  return out;
}

/** @param {Buffer} raw */
function deflateBest(raw) {
  const options = [
    { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
  ];
  /** @type {Buffer | null} */
  let best = null;
  for (const option of options) {
    const out = deflateSync(raw, option);
    if (!best || out.length < best.length) best = out;
  }
  return /** @type {Buffer} */ (best);
}

/**
 * The same image, encoded as small as this encoder can.
 * @param {Buffer} png
 * @returns {Buffer}
 */
export function optimize(png) {
  const { width, height, channels, pixels } = decode(png);
  let rgb = pixels;
  let bpp = channels;
  if (channels === 4) {
    let opaque = true;
    for (let i = 3; i < pixels.length; i += 4)
      if (pixels[i] !== 255) {
        opaque = false;
        break;
      }
    if (opaque) {
      rgb = Buffer.alloc(width * height * 3);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
        rgb[j] = pixels[i] ?? 0;
        rgb[j + 1] = pixels[i + 1] ?? 0;
        rgb[j + 2] = pixels[i + 2] ?? 0;
      }
      bpp = 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // A palette when the colours fit in one.
  if (bpp === 3) {
    /** @type {Map<number, number>} */
    const colours = new Map();
    for (let i = 0; i < rgb.length && colours.size <= 256; i += 3) {
      const key = ((rgb[i] ?? 0) << 16) | ((rgb[i + 1] ?? 0) << 8) | (rgb[i + 2] ?? 0);
      if (!colours.has(key)) colours.set(key, colours.size);
    }
    if (colours.size <= 256) {
      const indices = Buffer.alloc(width * height);
      for (let i = 0, j = 0; i < rgb.length; i += 3, j += 1) indices[j] = colours.get(((rgb[i] ?? 0) << 16) | ((rgb[i + 1] ?? 0) << 8) | (rgb[i + 2] ?? 0)) ?? 0;
      const palette = Buffer.alloc(colours.size * 3);
      for (const [key, index] of colours) {
        palette[index * 3] = (key >> 16) & 0xff;
        palette[index * 3 + 1] = (key >> 8) & 0xff;
        palette[index * 3 + 2] = key & 0xff;
      }
      ihdr[9] = 3;
      const idat = deflateBest(filtered(indices, width, height, 1, false));
      return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("PLTE", palette), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
    }
  }
  ihdr[9] = bpp === 4 ? 6 : 2;
  const idat = deflateBest(filtered(rgb, width, height, bpp, true));
  const out = Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  return out.length < png.length ? out : png;
}
