/**
 * Read a Server-Sent Events body and yield the `data:` payload of each event.
 * Handles events split across network chunks and multi-line data fields.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const data = dataOf(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (data !== undefined) {
        yield data;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  const data = dataOf(buffer);
  if (data !== undefined) {
    yield data;
  }
}

function dataOf(event: string): string | undefined {
  const lines = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  return lines.length > 0 ? lines.join("\n") : undefined;
}
