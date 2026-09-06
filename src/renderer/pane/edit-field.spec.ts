// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { editField } from './edit-field.ts'

describe('editField', () => {
  it('renders the value as read text initially', () => {
    const field = editField({ value: 'a note', placeholder: 'Add a note…', onSave: vi.fn() })
    const read = field.querySelector('.edit-field-read')
    expect(read).not.toBeNull()
    expect(read?.textContent).toBe('a note')
    expect(field.querySelector('.edit-field-input')).toBeNull()
  })

  it('shows the placeholder, muted, when the value is empty', () => {
    const field = editField({ value: '', placeholder: 'Add a note…', onSave: vi.fn() })
    const read = field.querySelector('.edit-field-read')
    expect(read?.textContent).toBe('Add a note…')
    expect(read?.classList.contains('edit-field-empty')).toBe(true)
  })

  it('clicking swaps to a focused textarea carrying the value', () => {
    const field = editField({ value: 'a note', placeholder: 'Add a note…', onSave: vi.fn() })
    document.body.appendChild(field)
    field.querySelector('.edit-field-read')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const textarea = field.querySelector<HTMLTextAreaElement>('.edit-field-input')
    expect(textarea).not.toBeNull()
    expect(textarea?.value).toBe('a note')
    expect(document.activeElement).toBe(textarea)
    field.remove()
  })

  it('clicking an empty value opens an empty textarea', () => {
    const field = editField({ value: '', placeholder: 'Add a note…', onSave: vi.fn() })
    document.body.appendChild(field)
    field.querySelector('.edit-field-read')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const textarea = field.querySelector<HTMLTextAreaElement>('.edit-field-input')
    expect(textarea?.value).toBe('')
    field.remove()
  })

  it('calls onSave once with the new value on blur, and reverts to read text', () => {
    const onSave = vi.fn()
    const field = editField({ value: 'a note', placeholder: 'Add a note…', onSave })
    document.body.appendChild(field)
    field.querySelector('.edit-field-read')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const textarea = field.querySelector<HTMLTextAreaElement>('.edit-field-input')
    if (!textarea) throw new Error('expected a textarea')
    textarea.value = 'a changed note'
    textarea.dispatchEvent(new Event('blur'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('a changed note')
    expect(field.querySelector('.edit-field-input')).toBeNull()
    expect(field.querySelector('.edit-field-read')?.textContent).toBe('a changed note')
    field.remove()
  })

  it('does NOT call onSave when blurring without a change', () => {
    const onSave = vi.fn()
    const field = editField({ value: 'a note', placeholder: 'Add a note…', onSave })
    document.body.appendChild(field)
    field.querySelector('.edit-field-read')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const textarea = field.querySelector<HTMLTextAreaElement>('.edit-field-input')
    textarea?.dispatchEvent(new Event('blur'))
    expect(onSave).not.toHaveBeenCalled()
    expect(field.querySelector('.edit-field-read')?.textContent).toBe('a note')
    field.remove()
  })

  it('Escape reverts without saving, even though the blur it may raise fires after', () => {
    const onSave = vi.fn()
    const field = editField({ value: 'a note', placeholder: 'Add a note…', onSave })
    document.body.appendChild(field)
    field.querySelector('.edit-field-read')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const textarea = field.querySelector<HTMLTextAreaElement>('.edit-field-input')
    if (!textarea) throw new Error('expected a textarea')
    textarea.value = 'a changed note'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    // reverted to read text synchronously
    expect(field.querySelector('.edit-field-input')).toBeNull()
    expect(field.querySelector('.edit-field-read')?.textContent).toBe('a note')
    // a blur that still lands on the (now-detached) textarea must not resurrect the save
    textarea.dispatchEvent(new Event('blur'))
    expect(onSave).not.toHaveBeenCalled()
    field.remove()
  })

  it('a subsequent edit after an Escape still saves normally', () => {
    const onSave = vi.fn()
    const field = editField({ value: 'a note', placeholder: 'Add a note…', onSave })
    document.body.appendChild(field)
    field.querySelector('.edit-field-read')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    field.querySelector('.edit-field-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    field.querySelector('.edit-field-read')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const textarea = field.querySelector<HTMLTextAreaElement>('.edit-field-input')
    if (!textarea) throw new Error('expected a textarea')
    textarea.value = 'second try'
    textarea.dispatchEvent(new Event('blur'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('second try')
    field.remove()
  })
})
