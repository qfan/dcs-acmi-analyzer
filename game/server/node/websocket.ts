/**
 * A minimal WebSocket server connection (RFC 6455), with no dependencies.
 *
 * Deliberately small: no extensions (so no permessage-deflate and no compression bombs), no
 * subprotocols. Frame lengths are checked against `maxMessageBytes` *before* the payload is buffered,
 * so an oversized frame costs no memory. Client frames must be masked, as the RFC requires.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Stop reading from a client whose unsent output piles up beyond this (bytes): it is too slow. */
const MAX_BUFFERED_OUT = 1024 * 1024;

export interface WsHandlers {
  onText(text: string, size: number): void;
  onBinary(data: Uint8Array): void;
  /** Called exactly once, however the connection ends. */
  onClose(code: number, reason: string): void;
}

export interface WsOptions {
  maxMessageBytes: number;
  /** Close when nothing (not even a pong) arrives for this long (ms). */
  idleTimeoutMs: number;
  /** Send a ping this often (ms) so proxies keep the connection open. */
  pingIntervalMs: number;
  /** Called with the size of every frame written, for the egress budget. */
  onBytesOut?: (n: number) => void;
}

/** Checks an upgrade request; returns the Sec-WebSocket-Accept value or an HTTP error. */
export function checkUpgrade(req: IncomingMessage): { accept: string } | { status: number; reason: string } {
  if (req.method !== "GET") return { status: 405, reason: "Method Not Allowed" };
  if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket")
    return { status: 426, reason: "Upgrade Required" };
  if (req.headers["sec-websocket-version"] !== "13") return { status: 426, reason: "Upgrade Required" };
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key))
    return { status: 400, reason: "Bad Request" };
  return {
    accept: createHash("sha1")
      .update(key + GUID)
      .digest("base64"),
  };
}

/** Writes a plain HTTP error on a socket that asked to upgrade, then closes it. */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class WsConnection {
  private readonly socket: Duplex;
  private readonly handlers: WsHandlers;
  private readonly opts: WsOptions;
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOp = 0;
  private fragmentBytes = 0;
  private closed = false;
  private closeSent = false;
  private lastSeen = Date.now();
  private readonly timer: NodeJS.Timeout;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  /** Completes the handshake on `socket` (after `checkUpgrade` succeeded). Call `start()` to read. */
  constructor(socket: Duplex, accept: string, handlers: WsHandlers, opts: WsOptions) {
    this.socket = socket;
    this.handlers = handlers;
    this.opts = opts;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > opts.idleTimeoutMs) this.close(1001, "idle");
      else this.writeFrame(OP_PING, Buffer.alloc(0));
    }, opts.pingIntervalMs);
    this.timer.unref();
  }

  /** Starts reading; `head` is any data that arrived with the upgrade request. */
  start(head?: Buffer): void {
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("close", () => this.finish(1006, "connection lost"));
    this.socket.on("error", () => this.finish(1006, "connection error"));
    if (head && head.length > 0) this.onData(head);
  }

  sendText(text: string): void {
    this.writeFrame(OP_TEXT, Buffer.from(text, "utf8"));
  }

  sendBinary(data: Uint8Array): void {
    this.writeFrame(OP_BINARY, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  /** Starts a clean close: sends a close frame and drops the socket shortly after. */
  close(code: number, reason: string): void {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const r = Buffer.from(reason.slice(0, 120), "utf8");
      const payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
      this.writeFrame(OP_CLOSE, payload, true);
    }
    this.socket.end();
    // Don't wait forever for the client's reply.
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.handlers.onClose(code, reason);
  }

  private writeFrame(op: number, payload: Buffer, force = false): void {
    if (this.closed || (this.closeSent && !force) || this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_BUFFERED_OUT) {
      this.close(1008, "client too slow");
      return;
    }
    const n = payload.length;
    const headLen = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const head = Buffer.alloc(headLen);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = n;
    else if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
    this.opts.onBytesOut?.(headLen + n);
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const consumed = this.parseFrame();
      if (consumed === 0) break;
      this.buf = this.buf.subarray(consumed);
    }
  }

  /** Parses one frame from the buffer; returns the bytes consumed, or 0 if it is incomplete. */
  private parseFrame(): number {
    const b = this.buf;
    if (b.length < 2) return 0;
    const b0 = b[0] as number;
    const b1 = b[1] as number;
    const fin = (b0 & 0x80) !== 0;
    const op = b0 & 0x0f;
    if ((b0 & 0x70) !== 0) return this.fail(1002, "reserved bits set");
    if ((b1 & 0x80) === 0) return this.fail(1002, "client frames must be masked");
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return 0;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return 0;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.opts.maxMessageBytes)) return this.fail(1009, "message too large");
      len = Number(big);
      off = 10;
    }
    const isControl = op >= 0x8;
    if (isControl && (len > 125 || !fin)) return this.fail(1002, "bad control frame");
    if (!isControl && this.fragmentBytes + len > this.opts.maxMessageBytes)
      return this.fail(1009, "message too large");
    if (b.length < off + 4 + len) return 0;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = (b[off + 4 + i] as number) ^ (mask[i & 3] as number);
    this.handleFrame(op, fin, payload);
    return off + 4 + len;
  }

  private handleFrame(op: number, fin: boolean, payload: Buffer): void {
    switch (op) {
      case OP_PING:
        this.writeFrame(OP_PONG, payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(code === 1005 ? 1000 : code, "closed by client");
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragmentOp !== 0) {
          this.fail(1002, "new message inside a fragmented one");
          return;
        }
        if (fin) {
          this.deliver(op, payload);
          return;
        }
        this.fragmentOp = op;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      case OP_CONT:
        if (this.fragmentOp === 0) {
          this.fail(1002, "continuation without a message");
          return;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          const wholeOp = this.fragmentOp;
          this.fragments = [];
          this.fragmentOp = 0;
          this.fragmentBytes = 0;
          this.deliver(wholeOp, whole);
        }
        return;
      default:
        this.fail(1002, "unknown opcode");
    }
  }

  private deliver(op: number, payload: Buffer): void {
    if (op === OP_BINARY) {
      this.handlers.onBinary(new Uint8Array(payload.buffer, payload.byteOffset, payload.length));
      return;
    }
    let text: string;
    try {
      text = this.utf8.decode(payload);
    } catch {
      this.fail(1007, "invalid UTF-8");
      return;
    }
    this.handlers.onText(text, payload.length);
  }

  private fail(code: number, reason: string): number {
    this.close(code, reason);
    return 0;
  }
}
