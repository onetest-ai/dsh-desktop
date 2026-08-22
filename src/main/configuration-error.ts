/**
 * A startup failure caused by something the user set in `desktop.json` — an
 * unresolvable launcher binary, a missing or unbuilt checkout, or an
 * unreadable or invalid config file.
 *
 * Distinguishing this from a harness that started correctly and then crashed
 * or timed out lets the caller decide whether reopening Settings helps: it
 * does for a configuration mistake, and is only noise for a harness that
 * misbehaved after a good configuration.
 */
export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigurationError'
  }
}
