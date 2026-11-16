'use client'

import type { ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { menuContentClass } from '@/components/shared/item-menu'
import type { Collected } from '@/lib/upload-folder-walk'

export function UploadMenu({ trigger, open, onOpenChange }: {
  onPick: (picked: Collected) => void
  trigger: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={menuContentClass}>
          <p className="max-w-xs p-3 text-sm text-text-secondary">
            Prepare and upload videos using Electron/Ingest. Web media uploads have been retired.
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
