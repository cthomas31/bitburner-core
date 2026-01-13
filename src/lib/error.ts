/** 
 * Returns a string representation of an error.
 * 
 * @param e The error to convert to a string.
 * @returns A string message describing the error.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}