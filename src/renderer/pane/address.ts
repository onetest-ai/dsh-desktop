/**
 * Turn what someone typed into a URL to load, or undefined.
 *
 * A bare host gets `https://`, because that is what typing `example.com` into
 * any address bar means. Anything that is still not an `http`/`https` URL
 * after that is refused rather than guessed at: this bar loads pages, and a
 * `file:` or `javascript:` URL typed here would be the same reach the view
 * tools already refuse.
 * @param text - what was typed.
 * @returns the URL to load, or undefined when there is none.
 */
export function normalizeAddress(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  // `localhost:3000` is a host and a port, not a scheme and a path, so a
  // scheme is only recognized when `//` follows it or what follows is not a
  // port number — which is what leaves `javascript:` and `data:` to be
  // refused by the protocol check below rather than given a scheme of ours.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)
  const candidate = scheme ? trimmed : `https://${trimmed}`
  try {
    const { protocol, hostname } = new URL(candidate)
    if (protocol !== 'http:' && protocol !== 'https:') return undefined
    return hostname === '' ? undefined : candidate
  } catch {
    // Not a URL even with a scheme in front of it — a search phrase, most
    // likely, which this bar does not do.
    return undefined
  }
}
