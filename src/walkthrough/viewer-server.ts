import http from 'node:http';
import type {AddressInfo} from 'node:net';

import log from '../logger.js';
import {createWalkthroughViewerHtml} from './viewer-page.js';

/** Input sent by the viewer page. Tap coordinates are screen fractions. */
export type ViewerInput =
  | {type: 'next' | 'back' | 'skip'}
  | {type: 'shown'; index: number}
  | {type: 'tap'; x: number; y: number}
  | {type: 'swipe'; x1: number; y1: number; x2: number; y2: number};

/** Message pushed to the viewer page over Server-Sent Events. */
export type ViewerMessage = Record<string, unknown> & {type: string};

/** One walkthrough as seen by the HTTP layer. */
export interface ViewerChannel {
  readonly id: string;
  /** Latest device screenshot as PNG bytes, and when it was taken (ms since epoch). */
  frame(): Promise<{png: Buffer; at: number}>;
  /** Called for every valid input from a viewer page. */
  onInput(input: ViewerInput): void;
}

const MAX_BODY_BYTES = 1024;
const ROUTE = /^\/walkthrough\/([0-9a-f-]{36})(\/frame|\/events|\/input)?\/?$/;

/**
 * Local HTTP server for walkthrough viewer pages, shared by all walkthroughs
 * in the process and started on first use.
 *
 * It binds to 127.0.0.1 by default (override with
 * APPIUM_MCP_WALKTHROUGH_HOST / APPIUM_MCP_WALKTHROUGH_PORT). A walkthrough
 * is reachable only under its random UUID, and the Host header is checked
 * so a web page elsewhere can't reach it through DNS rebinding: taps sent
 * to a viewer are forwarded to the device.
 */
export class WalkthroughViewerServer {
  private server: http.Server | null = null;
  private starting: Promise<void> | null = null;
  private readonly channels = new Map<string, ViewerChannel>();
  private readonly clients = new Map<string, Set<http.ServerResponse>>();
  private readonly lastStep = new Map<string, ViewerMessage>();

  constructor(
    private readonly host = process.env.APPIUM_MCP_WALKTHROUGH_HOST || '127.0.0.1',
    private readonly port = Number(process.env.APPIUM_MCP_WALKTHROUGH_PORT || 0),
  ) {}

  /** Register a walkthrough and return the viewer URL for it. */
  async open(channel: ViewerChannel): Promise<string> {
    await this.start();
    this.channels.set(channel.id, channel);
    return `${this.baseUrl()}/walkthrough/${channel.id}`;
  }

  /** Push a message to every viewer of a walkthrough. Steps are replayed to late joiners. */
  send(id: string, message: ViewerMessage): void {
    if (message.type === 'step') {
      this.lastStep.set(id, message);
    } else if (message.type === 'rect') {
      const step = this.lastStep.get(id);
      if (step) {
        step.rect = message.rect;
      }
    }
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of this.clients.get(id) ?? []) {
      res.write(data);
    }
  }

  /** Number of viewer pages currently connected to a walkthrough. */
  viewerCount(id: string): number {
    return this.clients.get(id)?.size ?? 0;
  }

  /** Send a final message, close the viewers' event streams and forget the walkthrough. */
  close(id: string, finalMessage?: ViewerMessage): void {
    if (finalMessage) {
      this.send(id, finalMessage);
    }
    for (const res of this.clients.get(id) ?? []) {
      res.end();
    }
    this.clients.delete(id);
    this.channels.delete(id);
    this.lastStep.delete(id);
  }

  /** Stop the HTTP server (tests, shutdown). */
  async stop(): Promise<void> {
    for (const id of [...this.channels.keys()]) {
      this.close(id);
    }
    const server = this.server;
    this.server = null;
    this.starting = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private boundPort(): number {
    const address = this.server?.address() as AddressInfo | string | null | undefined;
    return address && typeof address === 'object' ? address.port : 0;
  }

  private baseUrl(): string {
    const port = this.boundPort();
    const host = this.host.includes(':') ? `[${this.host}]` : this.host;
    return `http://${host}:${port}`;
  }

  private async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err: unknown) => {
          log.debug(`[walkthrough] viewer request failed: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500).end();
          } else {
            res.end();
          }
        });
      });
      server.once('error', (err) => {
        this.starting = null;
        reject(err);
      });
      server.listen(this.port, this.host, () => {
        server.unref();
        this.server = server;
        resolve();
      });
    });
    await this.starting;
  }

  private hostAllowed(req: http.IncomingMessage): boolean {
    if (!['127.0.0.1', 'localhost', '::1'].includes(this.host)) {
      // Deliberately exposed on another interface; the UUID path still guards it.
      return true;
    }
    const header = req.headers.host;
    if (!header) {
      return false;
    }
    const port = this.boundPort();
    return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(header.toLowerCase());
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://viewer');
    const match = ROUTE.exec(url.pathname);
    const channel = match ? this.channels.get(match[1]) : undefined;
    if (!this.hostAllowed(req) || !match || !channel) {
      res.writeHead(404).end();
      return;
    }
    const noStore = {'cache-control': 'no-store'};
    switch (match[2]) {
      case undefined: {
        if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        res.writeHead(200, {
          ...noStore,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        });
        res.end(createWalkthroughViewerHtml());
        return;
      }
      case '/frame': {
        const {png, at} = await channel.frame();
        res.writeHead(200, {...noStore, 'content-type': 'image/png', 'x-frame-at': String(at)});
        res.end(png);
        return;
      }
      case '/events': {
        res.writeHead(200, {
          ...noStore,
          'content-type': 'text/event-stream',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        let set = this.clients.get(channel.id);
        if (!set) {
          set = new Set();
          this.clients.set(channel.id, set);
        }
        set.add(res);
        req.on('close', () => set.delete(res));
        const step = this.lastStep.get(channel.id);
        if (step) {
          res.write(`data: ${JSON.stringify(step)}\n\n`);
        }
        return;
      }
      case '/input': {
        if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) {
          res.writeHead(415).end();
          return;
        }
        const input = parseInput(await readBody(req));
        if (!input) {
          res.writeHead(400).end();
          return;
        }
        channel.onInput(input);
        res.writeHead(204).end();
        return;
      }
    }
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      return '';
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Validate a viewer input payload. */
export function parseInput(body: string): ViewerInput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const {type, index, x, y, x1, y1, x2, y2} = raw as Record<string, unknown>;
  if (type === 'next' || type === 'back' || type === 'skip') {
    return {type};
  }
  if (type === 'shown' && Number.isInteger(index) && (index as number) >= 0) {
    return {type, index: index as number};
  }
  const inUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (type === 'tap' && inUnit(x) && inUnit(y)) {
    return {type, x, y};
  }
  if (type === 'swipe' && inUnit(x1) && inUnit(y1) && inUnit(x2) && inUnit(y2)) {
    return {type, x1, y1, x2, y2};
  }
  return null;
}

let shared: WalkthroughViewerServer | null = null;

/** The process-wide viewer server. */
export function getViewerServer(): WalkthroughViewerServer {
  shared ??= new WalkthroughViewerServer();
  return shared;
}
