/**
 * Render a self-contained failure page.
 * Chromium's own connection-refused page tells the user nothing actionable,
 * so every failure path loads this instead.
 * @param title - the short failure summary.
 * @param detail - the remedy or captured stderr.
 * @returns a data URL holding the rendered page.
 */
export function errorPage(title: string, detail: string): string {
  const escape = (value: string): string =>
    value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)

  const html = `<!doctype html>
<meta charset="utf-8">
<title>dsh-desktop</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; height: 100vh; padding: 2rem; }
  main { max-width: 46rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  pre { white-space: pre-wrap; word-break: break-word; padding: 1rem;
        background: rgba(127,127,127,.12); border-radius: .5rem; }
</style>
<main>
  <h1>${escape(title)}</h1>
  <pre>${escape(detail)}</pre>
</main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
