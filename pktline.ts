// pkt-line framing for the git smart-HTTP protocol (protocol v0 and v2).
//
// A pkt-line is 4 lowercase hex bytes giving the total length (header +
// payload), then the payload. Length 0 is a flush packet ("0000"), 1 is a
// delim packet ("0001"), 2 is a response-end packet ("0002"); 3 is invalid.
// The largest packet is 65520 bytes including its header, so a payload is at
// most 65516 bytes. Sideband packets carry one band byte (1 = data, 2 =
// progress, 3 = error) followed by at most 65515 bytes of content.
//
// Only Node built-ins are used. Nothing here touches the network or the clock.

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
export const SIDEBAND_MAX_DATA = PKT_LINE_MAX_PAYLOAD - 1;

export type PktLinePacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

function toBuffer(value: string | Buffer | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes then the payload. */
export function encodePktLine(payload: string | Buffer | Uint8Array): Buffer {
  const data = toBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new RangeError(
      `pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`,
    );
  }
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet ("0000"). */
export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet ("0001"). */
export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet ("0002"). Never sent inside a fetch response. */
export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush' / 'delim' / 'response-end' are controls. */
export function encodePktLines(
  items: ReadonlyArray<string | Buffer | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(encodeFlush());
    else if (item === 'delim') parts.push(encodeDelim());
    else if (item === 'response-end') parts.push(encodeResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Parse the single pkt-line starting at `offset` in `buf`.
 * Returns the packet and the offset just past it. Throws on a malformed
 * header, an invalid length, or a truncated packet. Use `nextOffset` to walk
 * a buffer packet by packet; anything after a flush packet is raw trailing
 * bytes (a receive-pack packfile), not pkt-lines.
 */
export function parsePktLineAt(
  buf: Buffer,
  offset: number,
): { packet: PktLinePacket; nextOffset: number } {
  if (offset + 4 > buf.length) {
    throw new Error(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
  }
  const header = buf.subarray(offset, offset + 4).toString('ascii');
  if (!HEX4.test(header)) {
    throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
  }
  const length = Number.parseInt(header, 16);
  if (length === 0) return { packet: { kind: 'flush' }, nextOffset: offset + 4 };
  if (length === 1) return { packet: { kind: 'delim' }, nextOffset: offset + 4 };
  if (length === 2) return { packet: { kind: 'response-end' }, nextOffset: offset + 4 };
  if (length === 3) throw new Error('invalid pkt-line length 0003');
  if (length > PKT_LINE_MAX) {
    throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
  }
  if (offset + length > buf.length) {
    throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
  }
  const raw = buf.subarray(offset, offset + length);
  return {
    packet: { kind: 'data', payload: raw.subarray(4), raw: Buffer.from(raw) },
    nextOffset: offset + length,
  };
}

/**
 * Decode a whole buffer of pkt-lines. Throws on malformed input.
 * With `allowTrailing`, stops (instead of throwing) when the bytes at the
 * cursor stop looking like a pkt-line header, and reports how many bytes
 * were consumed so the caller can take the rest as raw data.
 */
export function decodePktLines(
  buf: Buffer,
  options: { allowTrailing?: boolean } = {},
): { packets: PktLinePacket[]; consumed: number } {
  const packets: PktLinePacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (options.allowTrailing && offset + 4 <= buf.length) {
      const head = buf.subarray(offset, offset + 4).toString('ascii');
      if (!HEX4.test(head)) break;
    }
    const { packet, nextOffset } = parsePktLineAt(buf, offset);
    packets.push(packet);
    offset = nextOffset;
  }
  return { packets, consumed: offset };
}

/**
 * An incremental pkt-line decoder: push response chunks as they arrive and
 * pull complete packets with `next()`, which returns null while more bytes
 * are needed. `finish()` marks the stream ended; a truncated packet then
 * throws instead of silently dropping bytes. `takeBuffered()` hands back
 * every byte not yet consumed (the raw packfile after a receive-pack flush).
 */
export class PktLineDecoder {
  private buf = Buffer.alloc(0);
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  get bufferedBytes(): number {
    return this.buf.length;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error('pkt-line decoder received bytes after finish()');
    if (!chunk.length) return;
    this.buf = this.buf.length === 0 ? toBuffer(chunk) : Buffer.concat([this.buf, toBuffer(chunk)]);
  }

  finish(): void {
    this.ended = true;
  }

  get complete(): boolean {
    return this.ended && this.buf.length === 0;
  }

  /** Every buffered byte, unconsumed (raw data after the framed section). */
  takeBuffered(): Buffer {
    const out = this.buf;
    this.buf = Buffer.alloc(0);
    return out;
  }

  /** The next packet, or null when more bytes are needed. Throws on malformed input. */
  next(): PktLinePacket | null {
    if (this.buf.length < 4) {
      if (this.ended && this.buf.length > 0) {
        throw new Error(`truncated pkt-line: ${this.buf.length} trailing byte(s)`);
      }
      return null;
    }
    const header = this.buf.subarray(0, 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      this.buf = this.buf.subarray(4);
      return length === 0
        ? { kind: 'flush' }
        : length === 1
          ? { kind: 'delim' }
          : { kind: 'response-end' };
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) {
      throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    }
    if (this.buf.length < length) {
      if (this.ended) {
        throw new Error(`truncated pkt-line: ${length} announced, ${this.buf.length} available`);
      }
      return null;
    }
    const raw = Buffer.from(this.buf.subarray(0, length));
    this.buf = this.buf.subarray(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }
}

/**
 * Frame `data` as sideband packets on `band` (1 = data, 2 = progress,
 * 3 = error). Each packet holds the band byte plus at most 65515 bytes, so
 * no pkt-line exceeds 65520 bytes. Returns the concatenated packets.
 */
export function encodeSideband(band: 1 | 2 | 3, data: Buffer | Uint8Array): Buffer {
  const body = toBuffer(data);
  const parts: Buffer[] = [];
  let offset = 0;
  do {
    const chunk = body.subarray(offset, offset + SIDEBAND_MAX_DATA);
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(encodePktLine(payload));
    offset += chunk.length;
  } while (offset < body.length);
  return Buffer.concat(parts);
}

/** The text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly PktLinePacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}
