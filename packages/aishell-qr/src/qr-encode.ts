/**
 * Turning text into a PNG QR code, with no runtime dependency beyond the
 * encoder.
 *
 * ## Encoding in-process
 *
 * `qrencode` is a system package that may or may not be installed, and a tool
 * that assumes it fails on the machines that do not have it — at the moment a
 * user is trying to pay, with an error they cannot act on. Encoding here makes
 * the capability a property of the plugin rather than of the host it happens to
 * run on.
 *
 * It also carries the text exactly: a recharge URL has a `#` fragment, and a
 * shell round trip puts it one quoting mistake away from being dropped. Encoded
 * here, the bytes are the string.
 *
 * ## The PNG container
 *
 * A QR code is two colours, so the format needs the four chunks below and
 * nothing else. A PNG library would be a dependency carried by every install
 * for a code path that runs when someone asks to pay. `node:zlib` supplies the
 * compressor and the checksum, so what is left is the framing.
 *
 * @module @huaweidevtools/aishell-dsh-qr/qr-encode
 */

import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib'

import qr from 'qrcode-generator'

/** Pixels per QR module. Below 4 a phone camera struggles at arm's length. */
export const DEFAULT_SCALE = 8

/** Quiet zone in modules. The spec requires 4, and scanners rely on it. */
export const DEFAULT_MARGIN = 4

/**
 * Error-correction level.
 *
 * `M` recovers about 15% of the symbol. Higher levels survive more smudging but
 * spend modules on redundancy, which enlarges the image; a screen has no
 * smudging, so the level only has to cover a slightly unsteady hand.
 */
const ECC = 'M'

/** The result of encoding: a PNG, or the reason there is none. */
export type EncodeResult =
  | { readonly ok: true, readonly png: Buffer, readonly modules: number }
  | { readonly ok: false, readonly reason: string }

/**
 * Encode text into a PNG.
 *
 * @param text - the exact text to encode; nothing is trimmed or escaped, so the
 *   bytes scanned are the bytes given.
 * @param scale - pixels per module.
 * @param margin - quiet zone in modules.
 * @returns the PNG, or why the text could not be encoded.
 */
export function encodeQrPng(
  text: string,
  scale: number = DEFAULT_SCALE,
  margin: number = DEFAULT_MARGIN,
): EncodeResult {
  if (text.length === 0) return { ok: false, reason: 'There is no text to encode.' }

  // `0` asks the encoder for the smallest version that fits, so a short URL
  // stays sparse enough to scan and a longer one grows rather than failing.
  let code: ReturnType<typeof qr>
  try {
    code = qr(0, ECC)
    code.addData(text)
    code.make()
  } catch (error) {
    // Reported rather than thrown: too much text is an ordinary refusal, and a
    // caller that meant to encode a document needs to be told that, not handed
    // an exception from inside a library.
    return {
      ok: false,
      reason: `The text could not be encoded as a QR code: ${error instanceof Error ? error.message : String(error)}.`,
    }
  }

  const modules = code.getModuleCount()
  const size = (modules + margin * 2) * scale
  return { ok: true, png: pngFromModules(code, modules, scale, margin, size), modules }
}

/**
 * Frame a module grid as an 8-bit greyscale PNG.
 *
 * Greyscale rather than 1-bit or palette: a palette would need a `PLTE` chunk
 * and bit-packing would need per-row bit-order handling, for no gain at a few
 * hundred pixels. Every row is written with filter type 0 (none), which is
 * correct and costs a size the deflate pass then reclaims.
 *
 * @param code - the encoder's module grid.
 * @param modules - modules per side.
 * @param scale - pixels per module.
 * @param margin - quiet zone in modules.
 * @param size - total pixels per side.
 * @returns the encoded PNG.
 */
function pngFromModules(
  code: ReturnType<typeof qr>,
  modules: number,
  scale: number,
  margin: number,
  size: number,
): Buffer {
  // One filter byte per row, then one byte per pixel.
  const raw = Buffer.alloc((size + 1) * size)
  let at = 0
  for (let y = 0; y < size; y += 1) {
    raw[at] = 0
    at += 1
    const row = Math.floor(y / scale) - margin
    for (let x = 0; x < size; x += 1) {
      const col = Math.floor(x / scale) - margin
      const dark = row >= 0 && row < modules && col >= 0 && col < modules && code.isDark(row, col)
      raw[at] = dark ? 0 : 255
      at += 1
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // colour type: greyscale

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * One PNG chunk: length, type, payload, CRC over type and payload.
 *
 * @param type - the four-character chunk type.
 * @param data - the payload.
 * @returns the framed chunk.
 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  // `zlib.crc32` arrived in Node 20.15 and 22.x; the engines floor is 22.19, so
  // it is present on every supported runtime and needs no fallback.
  crc.writeUInt32BE(zlibCrc32(typed) >>> 0)
  return Buffer.concat([length, typed, crc])
}