import { describe, expect, it } from 'vitest'
import { isMedia, mediaKind } from './media-kind'

describe('mediaKind', () => {
  it.each(['shot.png', 'photo.JPG', 'logo.svg', 'anim.gif', 'icon.ico'])('shows %s as an image', (name) => {
    expect(mediaKind(name)).toBe('image')
  })

  it.each(['clip.mp4', 'demo.webm', 'recording.mov'])('shows %s as video', (name) => {
    expect(mediaKind(name)).toBe('video')
  })

  it.each(['note.mp3', 'sound.wav', 'track.flac'])('shows %s as audio', (name) => {
    expect(mediaKind(name)).toBe('audio')
  })

  it('shows a pdf as a pdf', () => {
    expect(mediaKind('report.pdf')).toBe('pdf')
  })

  // reason: a guess that a file is text costs a message the read produces
  // anyway; a guess that it is an image costs a broken viewer.
  it.each(['index.ts', 'notes.md', 'Makefile', 'archive.zip', 'noextension', ''])(
    'falls back to text for %s',
    (name) => {
      expect(mediaKind(name)).toBe('text')
    },
  )

  it('reads the extension from a path, not just a bare name', () => {
    expect(mediaKind('assets/img/logo.png')).toBe('image')
  })

  it('answers isMedia in step with the kind', () => {
    expect(isMedia('shot.png')).toBe(true)
    expect(isMedia('index.ts')).toBe(false)
  })
})
