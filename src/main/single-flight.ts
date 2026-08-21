/**
 * Wrap an async operation so overlapping calls never run it concurrently.
 * A call made while a run is already in progress does not start a new run;
 * it receives the same promise as the run already in flight, so the second
 * caller observes the first run's outcome instead of triggering its own.
 * @param fn - the operation to serialize.
 * @returns a wrapped function safe to call from multiple triggers at once.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined

  return () => {
    if (inFlight === undefined) {
      inFlight = fn().finally(() => {
        inFlight = undefined
      })
    }
    return inFlight
  }
}
