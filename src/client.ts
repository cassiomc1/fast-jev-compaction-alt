import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 15,000ms. */
  requestTimeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Jev request timed out after ${this.requestTimeoutMs}ms`)),
      this.requestTimeoutMs,
    );
    try {
      const response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
