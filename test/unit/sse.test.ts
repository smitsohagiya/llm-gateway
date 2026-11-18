import { describe, expect, it } from "vitest";

import { readSse } from "../../src/providers/sse.js";
import { streamResponse } from "../helpers/fake-fetch.js";

async function collect(pieces: string[]): Promise<string[]> {
  const out: string[] = [];
  const body = streamResponse(pieces).body;
  if (!body) throw new Error("no body");
  for await (const data of readSse(body)) out.push(data);
  return out;
}

describe("readSse", () => {
  it("joins events split across network chunks", async () => {
    expect(await collect(['data: {"a"', ":1}\n\ndata: [DO", "NE]\n\n"])).toEqual([
      '{"a":1}',
      "[DONE]",
    ]);
  });

  it("skips comments and event names, and joins multi-line data", async () => {
    expect(await collect([": ping\n\nevent: x\ndata: line1\ndata: line2\n\n"])).toEqual([
      "line1\nline2",
    ]);
  });

  it("handles CRLF line endings and a last event without a blank line", async () => {
    expect(await collect(["data: one\r\n\r\ndata: two"])).toEqual(["one", "two"]);
  });
});
