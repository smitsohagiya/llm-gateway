import type { FetchFn } from "../../src/providers/types.js";

export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A Response whose body arrives in the given pieces, like a real network stream. */
export function streamResponse(pieces: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** A fetch that records each request and answers with the next response in the list. */
export function fakeFetch(responses: (Response | Error)[]): { fetch: FetchFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      headers,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("no more fake responses"));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as FetchFn;
  return { fetch: fetchFn, calls };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
