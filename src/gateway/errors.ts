/** An error the gateway returns to the client, in OpenAI's error format. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }

  toBody(): { error: { message: string; type: string; code: string } } {
    return { error: { message: this.message, type: this.code, code: this.code } };
  }
}
