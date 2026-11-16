import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UploadMenu } from '../upload-menu'

describe('UploadMenu', () => {
  it('explains external preparation without exposing an unusable file picker', async () => {
    const onPick = vi.fn()
    const { container } = render(<UploadMenu onPick={onPick} trigger={<button>Upload</button>} />)
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(screen.getByText(/Prepare and upload videos using Electron\/Ingest/)).toBeInTheDocument()
    expect(container.querySelector('input[type="file"]')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Upload files|Upload folder/ })).toBeNull()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('can be dismissed with the keyboard', async () => {
    render(<UploadMenu onPick={vi.fn()} trigger={<button>Upload</button>} />)
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Upload' })).toHaveFocus()
  })
})
