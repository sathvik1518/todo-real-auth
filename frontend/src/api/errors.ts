/** The server answered, and the answer was "no" (404, 422, 500...). */
export class ServerError extends Error {
  readonly status: number;
  /** For a 422: which field said what, e.g. { title: "Title cannot be empty." } */
  readonly fieldErrors: Record<string, string>;

  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/** There was no answer at all: the server is off, the network is down, or it took too long. */
export class NetworkError extends Error {
  readonly reason: "unreachable" | "timeout";

  constructor(reason: "unreachable" | "timeout") {
    super(reason === "timeout" ? "The server took too long to answer." : "Could not reach the server.");
    this.name = "NetworkError";
    this.reason = reason;
  }
}
