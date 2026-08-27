import DOMPurify from 'dompurify'
import { marked } from 'marked'

/** Extensions this app will render rather than only show as text. */
const RENDERABLE = new Set(['md', 'markdown'])

/**
 * Whether a file can be shown rendered as well as as source.
 * @param name - the file's name or path.
 * @returns whether the preview toggle applies to it.
 */
export function isMarkdown(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && RENDERABLE.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Render markdown to HTML that is safe to insert.
 *
 * Sanitized without exception. The text comes from a file on disk — often one
 * an agent just wrote — and this page holds the preload that reaches the
 * filesystem, so a `<script>` or an `onerror=` reaching the DOM here would run
 * with that page's access.
 *
 * Links keep their `href` but are not followed in place: `openMarkdownLink`
 * is what decides where they go.
 * @param text - the markdown source.
 * @returns HTML with every script, event handler, and unsafe URL removed.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: false })
  return DOMPurify.sanitize(html, {
    // No `data:` and no `javascript:`; images and links may name http(s) and
    // relative paths only.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style'],
  })
}

/**
 * The URL a click inside a preview should open externally, if any.
 *
 * A preview is not a browser: following a link in place would replace the
 * rendered file with a web page inside the editor column, with no way back.
 * Only absolute http(s) links go anywhere at all; a relative link points at
 * the project, which this app does not resolve from a preview.
 * @param target - the element that was clicked.
 * @returns the URL to hand to the browser, or undefined.
 */
export function openMarkdownLink(target: Element | null): string | undefined {
  const anchor = target?.closest('a')
  const href = anchor?.getAttribute('href') ?? ''
  return href.startsWith('http://') || href.startsWith('https://') ? href : undefined
}
