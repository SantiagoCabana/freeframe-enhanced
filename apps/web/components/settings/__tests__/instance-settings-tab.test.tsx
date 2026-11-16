import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const GB = 1024 ** 3
const h = vi.hoisted(() => {
  const DEFAULT = { storage_limit_bytes: 0, storage_used_bytes: 1024 ** 3 }
  return { DEFAULT, data: DEFAULT as typeof DEFAULT & {
    upload_part_size_bytes?: number
    allow_original_downloads?: boolean
    compression_level?: number | null
  } | undefined }
})
vi.mock('swr', () => ({ default: () => ({ data: h.data, isLoading: false }), mutate: vi.fn() }))
const put = vi.fn()
vi.mock('@/lib/api', () => ({ api: { put: (...a: unknown[]) => put(...a) } }))
import { InstanceSettingsTab } from '../instance-settings-tab'
import { useBrandingStore } from '@/stores/branding-store'

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const limitInput = () => screen.getByLabelText(/storage limit/i) as HTMLInputElement
const modeSelect = () => screen.getByLabelText(/default sign-in method/i)
const originalsSelect = () => screen.getByLabelText(/outside a project/i)

describe('InstanceSettingsTab', () => {
  beforeEach(() => {
    put.mockReset().mockResolvedValue({})
    h.data = h.DEFAULT
    useBrandingStore.setState({ loaded: true, defaultLoginMode: 'magic_code' })
  })

  it('saves settings individually without a Save button', () => {
    render(<InstanceSettingsTab />)
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  describe('sign-in method', () => {
    it('saves only the sign-in method and updates branding', async () => {
      render(<InstanceSettingsTab />)
      fireEvent.change(modeSelect(), { target: { value: 'password' } })
      await waitFor(() => expect(useBrandingStore.getState().defaultLoginMode).toBe('password'))
      expect(put).toHaveBeenCalledTimes(1)
      expect(put).toHaveBeenCalledWith('/instance/branding', { default_login_mode: 'password' })
      expect(screen.getByText('Saved')).toBeInTheDocument()
    })
    it('disables the control with its new value while saving', async () => {
      const d = deferred()
      put.mockReturnValue(d.promise)
      render(<InstanceSettingsTab />)
      fireEvent.change(modeSelect(), { target: { value: 'password' } })
      expect(modeSelect()).toHaveValue('password')
      expect(modeSelect()).toBeDisabled()
      d.resolve({})
      await waitFor(() => expect(modeSelect()).not.toBeDisabled())
      expect(modeSelect()).toHaveValue('password')
    })
    it('reverts and reports failed saves without changing branding', async () => {
      put.mockRejectedValue(new Error('nope'))
      render(<InstanceSettingsTab />)
      fireEvent.change(modeSelect(), { target: { value: 'password' } })
      await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument())
      expect(modeSelect()).toHaveValue('magic_code')
      expect(modeSelect()).not.toBeDisabled()
      expect(useBrandingStore.getState().defaultLoginMode).toBe('magic_code')
      expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })
    it('waits for branding to load', () => {
      useBrandingStore.setState({ loaded: false, fetchBranding: vi.fn() })
      render(<InstanceSettingsTab />)
      expect(modeSelect()).toBeDisabled()
    })
  })

  describe('storage limit', () => {
    it('saves once on blur, not while typing', async () => {
      render(<InstanceSettingsTab />)
      for (const value of ['1', '10', '100']) fireEvent.change(limitInput(), { target: { value } })
      expect(put).not.toHaveBeenCalled()
      fireEvent.blur(limitInput())
      await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
      expect(put).toHaveBeenCalledTimes(1)
      expect(put).toHaveBeenCalledWith('/instance/settings', { storage_limit_bytes: 100 * GB })
    })
    it('does not double-save Enter followed by blur', async () => {
      render(<InstanceSettingsTab />)
      limitInput().focus()
      fireEvent.change(limitInput(), { target: { value: '10' } })
      fireEvent.keyDown(limitInput(), { key: 'Enter' })
      fireEvent.blur(limitInput())
      await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
      expect(put).toHaveBeenCalledTimes(1)
    })
    it('does not save an unchanged value', () => {
      h.data = { ...h.DEFAULT, storage_limit_bytes: 5 * GB }
      render(<InstanceSettingsTab />)
      expect(limitInput()).toHaveValue(5)
      fireEvent.blur(limitInput())
      fireEvent.change(limitInput(), { target: { value: '5.0' } })
      fireEvent.blur(limitInput())
      expect(put).not.toHaveBeenCalled()
    })
    it('restores a blank field rather than removing the quota', () => {
      h.data = { ...h.DEFAULT, storage_limit_bytes: 5 * GB }
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '' } })
      fireEvent.blur(limitInput())
      expect(put).not.toHaveBeenCalled()
      expect(limitInput()).toHaveValue(5)
    })
    it('accepts explicit zero as unlimited', async () => {
      h.data = { ...h.DEFAULT, storage_limit_bytes: 5 * GB }
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '0' } })
      fireEvent.blur(limitInput())
      await waitFor(() => expect(put).toHaveBeenCalledWith('/instance/settings', { storage_limit_bytes: 0 }))
    })
    it('rejects browser-reported invalid numeric input', () => {
      h.data = { ...h.DEFAULT, storage_limit_bytes: 5 * GB }
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '' } })
      Object.defineProperty(limitInput(), 'validity', { value: { badInput: true }, configurable: true })
      fireEvent.blur(limitInput())
      expect(put).not.toHaveBeenCalled()
      expect(screen.getByText(/enter a number of gb/i)).toBeInTheDocument()
    })
    it('rejects positive limits that round down to unlimited', () => {
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '0.0000000001' } })
      fireEvent.blur(limitInput())
      expect(put).not.toHaveBeenCalled()
      expect(screen.getByText(/too small/i)).toBeInTheDocument()
    })
    it('shows save errors', async () => {
      put.mockRejectedValue(new Error('quota service down'))
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '10' } })
      fireEvent.blur(limitInput())
      await waitFor(() => expect(screen.getByText('quota service down')).toBeInTheDocument())
      expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })
    it('cannot save before settings load', () => {
      h.data = undefined
      render(<InstanceSettingsTab />)
      expect(limitInput()).toBeDisabled()
    })
  })

  describe('original downloads', () => {
    it('offers review media by default', () => {
      render(<InstanceSettingsTab />)
      expect(originalsSelect()).toHaveValue('transcode')
    })
    it('updates only the download policy', async () => {
      render(<InstanceSettingsTab />)
      fireEvent.change(originalsSelect(), { target: { value: 'original' } })
      await waitFor(() => expect(put).toHaveBeenCalledWith('/instance/settings', { allow_original_downloads: true }))
    })
    it('shows the stored policy', () => {
      h.data = { ...h.DEFAULT, allow_original_downloads: true }
      render(<InstanceSettingsTab />)
      expect(originalsSelect()).toHaveValue('original')
    })
    it('reverts and reports failed saves', async () => {
      put.mockRejectedValue(new Error('nope'))
      render(<InstanceSettingsTab />)
      fireEvent.change(originalsSelect(), { target: { value: 'original' } })
      await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument())
      expect(originalsSelect()).toHaveValue('transcode')
    })
    it('waits for settings to load', () => {
      h.data = undefined
      render(<InstanceSettingsTab />)
      expect(originalsSelect()).toBeDisabled()
    })
  })

  it.each([undefined, 1, 5])('does not expose retired processing controls even with stored compression %s', (compression_level) => {
    h.data = { ...h.DEFAULT, compression_level, upload_part_size_bytes: 64 * 1024 ** 2 }
    render(<InstanceSettingsTab />)
    expect(screen.queryByLabelText(/^compression:/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/upload part size/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use server default/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Electron\/Ingest/)).toBeInTheDocument()
    expect(put).not.toHaveBeenCalled()
  })
})
