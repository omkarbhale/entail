import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ForgeMethod, ForgeRequest, ForgeResponse, Transport } from "../../src/forge/transport.ts";
import { TransportError } from "../../src/forge/transport.ts";

/**
 * One recorded request and what came back: an HTTP response, or a transport
 * failure where no HTTP response came back (such as a logged-out CLI).
 */
export interface Exchange {
  /** A write's request records its JSON body; a read has none. */
  request: { method: ForgeMethod; path: string; headers?: Record<string, string>; body?: unknown };
  response?: { status: number; headers?: Record<string, string>; body?: unknown };
  error?: { message: string; loggedOut: boolean };
}

/** A file of recorded exchanges for one host. */
export interface Recording {
  host: string;
  exchanges: Exchange[];
}

export function loadRecording(url: URL): Recording {
  return JSON.parse(readFileSync(url, "utf8")) as Recording;
}

/**
 * The transport seam replaced by recorded responses. It expects exactly the
 * recorded requests in the recorded order, headers and bodies included, and
 * answers each with its recorded response.
 */
export class RecordedTransport implements Transport {
  readonly #host: string;
  readonly #exchanges: Exchange[];
  readonly requests: ForgeRequest[] = [];

  constructor(recording: Recording) {
    this.#host = recording.host;
    this.#exchanges = [...recording.exchanges];
  }

  async request(request: ForgeRequest): Promise<ForgeResponse> {
    this.requests.push(request);
    const next = this.#exchanges.shift();
    assert.ok(next, `unexpected request: ${request.method} ${request.path}`);
    assert.deepEqual(
      { host: request.host, method: request.method, path: request.path, headers: request.headers ?? {}, body: request.body },
      { host: this.#host, method: next.request.method, path: next.request.path, headers: next.request.headers ?? {}, body: next.request.body },
      "the request is the next one recorded",
    );
    if (next.error) throw new TransportError(next.error.message, next.error.loggedOut);
    assert.ok(next.response, "an exchange records a response or an error");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(next.response.headers ?? {})) headers[name.toLowerCase()] = value;
    const { body } = next.response;
    return {
      status: next.response.status,
      headers,
      body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
    };
  }

  /** Fails unless every recorded exchange was asked for. */
  assertDone(): void {
    assert.deepEqual(
      this.#exchanges.map((e) => e.request.path),
      [],
      "every recorded request was made",
    );
  }
}
