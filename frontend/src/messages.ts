import { NetworkError, ServerError } from "./api/errors";

/**
 * One sentence for the person, and a DIFFERENT one for "the server said no" and "there is no server".
 * They need different actions: a server error means wait or fix the input; no server means check it is running.
 */
const NO_SERVER = "Cannot reach the server. Check that it is running, then try again.";

// 502, 503 and 504 come from a proxy standing in front of the server (the Vite dev proxy answers 502 when the backend is off).
// The browser did get an answer, but the answer means "nothing is there", so it gets the no-server sentence, not "the server had a problem".
const GATEWAY_STATUSES = [502, 503, 504];

export function describeError(error: unknown): string {
  if (error instanceof NetworkError) {
    return error.reason === "timeout" ? "The server took too long to answer. Try again in a moment." : NO_SERVER;
  }
  if (error instanceof ServerError) {
    if (GATEWAY_STATUSES.includes(error.status)) return NO_SERVER;
    if (error.status >= 500) return `The server had a problem (${error.status}). It is not your fault. Try again in a moment.`;
    const fields = Object.values(error.fieldErrors);
    if (error.status === 422) return fields.length ? fields.join(" ") : "Please check what you typed.";
    return error.message;
  }
  return "Something went wrong.";
}
