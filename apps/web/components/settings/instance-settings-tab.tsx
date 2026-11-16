"use client";

import * as React from "react";
import useSWR, { mutate } from "swr";
import { Check, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { bytesToGb, gbToBytes } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { StorageUsage } from "@/components/shared/storage-usage";
import { useBrandingStore, type LoginMode } from "@/stores/branding-store";
import type { InstanceSettings } from "@/types";

const LOGIN_MODE_LABELS: Record<LoginMode, string> = {
  magic_code: "Magic code",
  password: "Email & password",
};

type OriginalDownloads = "transcode" | "original";
const ORIGINAL_DOWNLOADS_LABELS: Record<OriginalDownloads, string> = {
  transcode: "Review media",
  original: "Original and review media",
};

/** A "Saved" flag that clears itself after 2s; a second save restarts the clock. */
function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const flash = React.useCallback(() => {
    clearTimeout(timer.current);
    setSaved(true);
    timer.current = setTimeout(() => setSaved(false), 2000);
  }, []);
  return [saved, flash];
}

function SavedMark() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-status-success">
      <Check className="h-3.5 w-3.5" />
      Saved
    </span>
  );
}

function formatGb(bytes: number): string {
  return String(bytesToGb(bytes));
}

export function InstanceSettingsTab() {
  const { data } = useSWR<InstanceSettings>(
    "/instance/settings",
    () => api.get<InstanceSettings>("/instance/settings"),
  );
  const { defaultLoginMode, setDefaultLoginMode, loaded: brandingLoaded, fetchBranding } = useBrandingStore();
  const [gb, setGb] = React.useState<string>("");
  const [limitSaving, setLimitSaving] = React.useState(false);
  const limitInFlight = React.useRef(false);
  const [limitError, setLimitError] = React.useState("");
  const [limitSaved, flashLimitSaved] = useSavedFlash();
  const [pendingMode, setPendingMode] = React.useState<LoginMode | null>(null);
  const [modeError, setModeError] = React.useState("");
  const [modeSaved, flashModeSaved] = useSavedFlash();

  // Storage usage revalidation must not clobber a limit being edited.
  React.useEffect(() => {
    if (data) setGb(formatGb(data.storage_limit_bytes));
  }, [data?.storage_limit_bytes]);

  React.useEffect(() => {
    if (!brandingLoaded) fetchBranding();
  }, [brandingLoaded, fetchBranding]);

  const [pendingOriginals, setPendingOriginals] = React.useState<OriginalDownloads | null>(null);
  const [originalsError, setOriginalsError] = React.useState("");
  const [originalsSaved, flashOriginalsSaved] = useSavedFlash();
  const originals: OriginalDownloads =
    pendingOriginals ?? (data?.allow_original_downloads ? "original" : "transcode");

  const handleOriginalsChange = async (value: OriginalDownloads) => {
    if (value === originals) return;
    setPendingOriginals(value);
    setOriginalsError("");
    try {
      const updated = await api.put<InstanceSettings>("/instance/settings", {
        allow_original_downloads: value === "original",
      });
      mutate("/instance/settings", updated, { revalidate: false });
      flashOriginalsSaved();
    } catch (err: unknown) {
      setOriginalsError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setPendingOriginals(null);
    }
  };

  const handleModeChange = async (mode: LoginMode) => {
    setPendingMode(mode);
    setModeError("");
    try {
      await api.put("/instance/branding", { default_login_mode: mode });
      setDefaultLoginMode(mode);
      flashModeSaved();
    } catch (err: unknown) {
      setModeError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setPendingMode(null);
    }
  };

  const commitLimit = async (input: HTMLInputElement) => {
    if (!data || limitInFlight.current) return;
    const saved = data.storage_limit_bytes;
    if (input.validity.badInput) {
      setLimitError("Enter a number of GB, or 0 for unlimited.");
      return;
    }
    const raw = gb.trim();
    if (raw === "") {
      setGb(formatGb(saved));
      setLimitError("");
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setLimitError("Enter a number of GB, or 0 for unlimited.");
      return;
    }
    const bytes = gbToBytes(n);
    if (n > 0 && bytes === 0) {
      setLimitError("That's too small to be a limit. Enter 0 for unlimited.");
      return;
    }
    setLimitError("");
    if (bytes === saved) return;
    limitInFlight.current = true;
    setLimitSaving(true);
    try {
      const updated = await api.put<InstanceSettings>("/instance/settings", {
        storage_limit_bytes: bytes,
      });
      mutate("/instance/settings", updated, { revalidate: false });
      flashLimitSaved();
    } catch (err: unknown) {
      setLimitError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      limitInFlight.current = false;
      setLimitSaving(false);
    }
  };

  return (
    <div className="space-y-8 max-w-md">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Instance storage</h2>
        {data && <StorageUsage used={data.storage_used_bytes} limit={data.storage_limit_bytes} variant="panel" />}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="storage-limit-gb" className="text-sm font-medium text-text-secondary">Storage limit (GB)</label>
            {limitSaved && <SavedMark />}
          </div>
          <Input
            id="storage-limit-gb"
            type="number"
            min={0}
            value={gb}
            onChange={(e) => setGb(e.target.value)}
            onBlur={(e) => commitLimit(e.currentTarget)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            disabled={!data || limitSaving}
          />
          {limitError ? <p className="text-xs text-status-error">{limitError}</p> : <p className="text-xs text-text-tertiary">Enter 0 for unlimited.</p>}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Media preparation</h2>
        <p className="text-xs text-text-tertiary">Prepare and upload videos with Electron/Ingest. This server does not encode media.</p>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Downloads</h2>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="original-downloads" className="text-sm font-medium text-text-secondary">Outside a project</label>
            {originalsSaved && <SavedMark />}
          </div>
          <div className="relative">
            <select
              id="original-downloads"
              value={originals}
              onChange={(e) => handleOriginalsChange(e.target.value as OriginalDownloads)}
              disabled={!data || pendingOriginals !== null}
              className="w-full appearance-none cursor-pointer rounded-md border border-border bg-bg-secondary py-1.5 pl-3 pr-8 text-sm text-text-primary transition-colors hover:border-border-focus focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(Object.keys(ORIGINAL_DOWNLOADS_LABELS) as OriginalDownloads[]).map((value) => (
                <option key={value} value={value}>{ORIGINAL_DOWNLOADS_LABELS[value]}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          </div>
          {originalsError ? <p className="text-xs text-status-error">{originalsError}</p> : (
            <p className="text-xs text-text-tertiary">
              Controls original downloads outside a project. Originals are offered only when stored;
              prepared HLS streams are available as ZIP packages. Existing standalone review files remain available.
            </p>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Sign-in</h2>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="default-login-mode" className="text-sm font-medium text-text-secondary">Default sign-in method</label>
            {modeSaved && <SavedMark />}
          </div>
          <div className="relative">
            <select
              id="default-login-mode"
              value={pendingMode ?? defaultLoginMode}
              onChange={(e) => handleModeChange(e.target.value as LoginMode)}
              disabled={!brandingLoaded || pendingMode !== null}
              className="w-full appearance-none cursor-pointer rounded-md border border-border bg-bg-secondary py-1.5 pl-3 pr-8 text-sm text-text-primary transition-colors hover:border-border-focus focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(Object.keys(LOGIN_MODE_LABELS) as LoginMode[]).map((mode) => (
                <option key={mode} value={mode}>{LOGIN_MODE_LABELS[mode]}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          </div>
          {modeError ? <p className="text-xs text-status-error">{modeError}</p> : (
            <p className="text-xs text-text-tertiary">What the sign-in page shows first. People can still switch to the other method.</p>
          )}
        </div>
      </section>
    </div>
  );
}
