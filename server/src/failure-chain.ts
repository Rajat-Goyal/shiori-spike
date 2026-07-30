const FRAME_PATTERN = /^\s+at\s/;

/**
 * Error class names for an error and its `cause` chain, outermost first.
 *
 * Messages are deliberately excluded. A thrown message can embed arbitrary
 * owner text, a Telegram token, or a webhook secret — anything that reached the
 * failing call — so only the class names are safe to log. Names still separate a
 * Supabase failure from a provider failure, which is the diagnostic that matters.
 */
export function failureChain(
  error: unknown,
  limit = 5,
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current instanceof Error &&
    names.length < limit &&
    !seen.has(current)
  ) {
    seen.add(current);
    names.push(
      current.name === "Error"
        ? current.constructor.name
        : current.name,
    );
    current = current.cause;
  }
  return names.length > 0 ? names : ["UnknownFailure"];
}

/**
 * Stack frames for an error, with every `Name: message` header line removed.
 *
 * `error.stack` begins with the message, so the raw value carries the same
 * disclosure risk as the message itself. Frames alone give the failing
 * `file:line`, which is what identifies the operation.
 */
export function failureFrames(
  error: unknown,
  limit = 8,
): readonly string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return [];
  }
  return error.stack
    .split("\n")
    .filter((line) => FRAME_PATTERN.test(line))
    .slice(0, limit)
    .map((line) => line.trim());
}
