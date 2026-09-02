import * as monaco from 'monaco-editor'
import type { Document, Documents } from './editor.ts'
import { mediaKind } from './media-kind.ts'

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
// load rather than per document: it is process-wide state, and Monaco caches
// the workers it starts.
;(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => new Worker(`${ORIGIN}/${WORKERS[label] ?? 'editor.worker.js'}`),
}

/**
 * Switch every open editor to the other theme.
 *
 * Monaco's themes are process-wide, so this is one call rather than one per
 * document — and it must be called, since an editor created in one theme does
 * not follow a change on its own.
 * @param dark - whether dark is now in effect.
 */
export function setEditorTheme(dark: boolean): void {
  monaco.editor.setTheme(dark ? 'vs-dark' : 'vs')
}

/**
 * The options every editor here shares.
 *
 * No `theme`: Monaco's theme is process-wide, and passing one to `create`
 * sets it globally — so an editor created with a stale value flips every
 * other document back with it. `setEditorTheme` owns the theme alone.
 */
function options(): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    tabSize: 2,
    renderWhitespace: 'selection',
  }
}

/**
 * A unique model URI for one document.
 *
 * Two models over one path would be the same model — which is how a diff
 * would end up comparing a document with itself, and how a second tab for one
 * file would silently share the first one's buffer.
 * @param path - the file's path within its project.
 * @param role - what this model is for.
 * @returns the URI.
 */
function uriFor(path: string, role: string): monaco.Uri {
  return monaco.Uri.file(path).with({ scheme: role })
}

/**
 * Hold the open documents in one host, showing one at a time.
 *
 * One host element per document, shown and hidden, rather than one editor
 * whose model is swapped: Monaco keeps view state — scroll position, folded
 * regions, the cursor — per editor, so swapping models on a shared editor
 * loses exactly what a tab is supposed to remember.
 * @param host - the element to fill.
 * @returns the documents.
 */
export function monacoDocuments(host: HTMLElement): Documents {
  let counter = 0

  /**
   * Give one document its own layer in the host.
   * @returns the layer, already hidden.
   */
  const layer = (): HTMLElement => {
    const element = document.createElement('div')
    element.className = 'editor-layer'
    element.hidden = true
    host.append(element)
    return element
  }

  /**
   * Show one layer and hide every other.
   * @param mine - the layer to show.
   */
  const only = (mine: HTMLElement): void => {
    for (const each of host.children) (each as HTMLElement).hidden = each !== mine
  }

  return {
    open: (text, name) => {
      const element = layer()
      counter += 1
      const model = monaco.editor.createModel(text, undefined, uriFor(name, `file${String(counter)}`))
      const editor = monaco.editor.create(element, { ...options(), model })
      return document_(element, only, editor, model, () => {
        editor.dispose()
        // Disposed separately: a model outlives the editor showing it, and
        // leaking one keeps its whole document and language service alive.
        model.dispose()
      })
    },
    openMedia: (url, name) => {
      const element = layer()
      element.className = 'editor-layer media-layer'
      element.append(mediaElement(url, name))
      return {
        // Nothing here is text: the file is shown from disk, not read.
        text: () => '',
        selection: () => '',
        activate: () => only(element),
        destroy: () => element.remove(),
      }
    },
    openDiff: (original, proposed, name, inline = false) => {
      const element = layer()
      counter += 1
      const left = monaco.editor.createModel(original, undefined, uriFor(name, `ondisk${String(counter)}`))
      const right = monaco.editor.createModel(proposed, undefined, uriFor(name, `proposed${String(counter)}`))
      const editor = monaco.editor.createDiffEditor(element, {
        ...options(),
        readOnly: true,
        // One pane rather than two: a git diff is read the way a patch is.
        renderSideBySide: !inline,
      })
      editor.setModel({ original: left, modified: right })
      return document_(element, only, editor.getModifiedEditor(), right, () => {
        editor.dispose()
        left.dispose()
        right.dispose()
      })
    },
  }
}

/**
 * Wrap one editor and model as a document.
 * @param element - the layer it renders in.
 * @param only - shows one layer and hides the rest.
 * @param editor - the editor to read the selection from.
 * @param model - the model holding the text.
 * @param destroy - releases the editor and its models.
 * @returns the document.
 */
function document_(
  element: HTMLElement,
  only: (mine: HTMLElement) => void,
  editor: monaco.editor.ICodeEditor,
  model: monaco.editor.ITextModel,
  destroy: () => void,
): Document {
  return {
    text: () => model.getValue(),
    selection: () => {
      const range = editor.getSelection()
      return range === null ? '' : model.getValueInRange(range)
    },
    activate: () => {
      only(element)
      // Monaco measures on layout, and a hidden element measures as nothing —
      // so a document shown for the first time needs telling.
      editor.layout()
    },
    destroy: () => {
      destroy()
      element.remove()
    },
  }
}

/**
 * The element that shows one non-text file.
 *
 * A PDF gets an `<embed>`, which is what hands it to Chromium's own viewer;
 * anything unrecognized gets a link, since a file the pane cannot render is
 * still a file the user may want to open.
 * @param url - where the pane can load the file from.
 * @param name - the file's path, which chooses the viewer.
 * @returns the element to show.
 */
function mediaElement(url: string, name: string): HTMLElement {
  switch (mediaKind(name)) {
    case 'image': {
      const image = document.createElement('img')
      image.src = url
      image.alt = name
      return image
    }
    case 'video': {
      const video = document.createElement('video')
      video.src = url
      video.controls = true
      return video
    }
    case 'audio': {
      const audio = document.createElement('audio')
      audio.src = url
      audio.controls = true
      return audio
    }
    case 'pdf': {
      const embed = document.createElement('embed')
      embed.src = url
      embed.type = 'application/pdf'
      return embed
    }
    default: {
      const link = document.createElement('a')
      link.href = url
      link.textContent = `Open ${name}`
      return link
    }
  }
}
