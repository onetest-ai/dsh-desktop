import * as monaco from 'monaco-editor'
import type { Surface } from './editor.ts'

/**
 * Where the pane and its workers are served from.
 *
 * A custom scheme rather than `file://`: Chromium refuses to construct a
 * Worker from a file page, and Monaco's language services — the TypeScript and
 * JSON intelligence this editor is here for — are workers.
 */
const ORIGIN = 'app://pane'

/**
 * Which worker bundle serves each language service.
 *
 * Monaco asks by label; anything not listed gets the plain editor worker,
 * which is what drives diffing and tokenization for every other language.
 */
const WORKERS: Record<string, string> = {
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
  json: 'json.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
}

// Monaco reads this off the global before it starts any worker. Set at module
// load rather than per mount: it is process-wide state, and Monaco caches the
// workers it starts.
;(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => new Worker(`${ORIGIN}/${WORKERS[label] ?? 'editor.worker.js'}`),
}

/**
 * Mount a document in Monaco.
 *
 * The model is created against a `file:` URI so Monaco picks the language
 * from the extension itself — its own table, kept current with the editor,
 * rather than one this app would have to maintain.
 * @param host - the element to fill.
 * @param text - the document's contents.
 * @param path - the file's path within its project.
 * @param dark - whether to use the dark theme.
 * @returns the mounted surface.
 */
export function mountMonaco(host: HTMLElement, text: string, path: string, dark: boolean): Surface {
  const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(path))
  const editor = monaco.editor.create(host, { ...options(dark), model })
  return {
    text: () => model.getValue(),
    selection: () => {
      const range = editor.getSelection()
      return range === null ? '' : model.getValueInRange(range)
    },
    destroy: () => {
      editor.dispose()
      // Disposed separately: a model outlives the editor showing it, and
      // leaking one keeps its whole document and language service alive.
      model.dispose()
    },
  }
}

/**
 * Mount a file beside the text an agent proposes for it.
 *
 * Read-only on both sides: this is a change to look at before it happens, not
 * one to edit here — the agent writes the file, or it does not.
 * @param host - the element to fill.
 * @param original - the file as it is on disk.
 * @param proposed - the text the agent proposes.
 * @param path - the file's path within its project.
 * @param dark - whether to use the dark theme.
 * @returns the mounted surface, whose text is the proposed side.
 */
export function mountDiff(
  host: HTMLElement,
  original: string,
  proposed: string,
  path: string,
  dark: boolean,
): Surface {
  // Distinct URIs: two models over one path would be the same model, and the
  // diff would compare a document with itself.
  const left = monaco.editor.createModel(original, undefined, monaco.Uri.file(path).with({ scheme: 'ondisk' }))
  const right = monaco.editor.createModel(proposed, undefined, monaco.Uri.file(path).with({ scheme: 'proposed' }))
  const editor = monaco.editor.createDiffEditor(host, { ...options(dark), readOnly: true, renderSideBySide: true })
  editor.setModel({ original: left, modified: right })
  return {
    text: () => right.getValue(),
    selection: () => {
      const range = editor.getModifiedEditor().getSelection()
      return range === null ? '' : right.getValueInRange(range)
    },
    destroy: () => {
      editor.dispose()
      left.dispose()
      right.dispose()
    },
  }
}

/**
 * The options both surfaces share.
 * @param dark - whether to use the dark theme.
 * @returns the editor options.
 */
function options(dark: boolean): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    theme: dark ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    tabSize: 2,
    renderWhitespace: 'selection',
  }
}
