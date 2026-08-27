/**
 * The script that extracts a page's readable text, run in the page itself.
 *
 * Article and main content first, falling back to the body: a page's chrome —
 * nav, footer, cookie banner — is noise in something the agent is reading for
 * content, and `innerText` already drops what is hidden.
 *
 * Bounded, because a page can be enormous and the whole thing lands in the
 * model's context. The cut is reported rather than silent, so the agent knows
 * it is reading a beginning rather than a whole.
 * @param limit - the most characters to return.
 * @returns the script's source.
 */
export function pageTextScript(limit: number): string {
  return `(() => {
    const source = document.querySelector('article') ?? document.querySelector('main') ?? document.body
    const text = (source?.innerText ?? '').replace(/\\n{3,}/g, '\\n\\n').trim()
    const limit = ${String(limit)}
    return {
      title: document.title,
      url: location.href,
      text: text.length > limit ? text.slice(0, limit) + '\\n\\n[…truncated at ' + limit + ' characters]' : text,
    }
  })()`
}

/** The most characters a page is read as; beyond this the model is reading noise. */
export const PAGE_TEXT_LIMIT = 40_000
