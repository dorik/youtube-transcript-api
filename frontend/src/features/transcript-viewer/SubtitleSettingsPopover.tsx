'use client';

import { useEffect, useRef, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  FONT_SIZES,
  TEXT_COLORS,
  HIGHLIGHT_COLORS,
  type SubtitleSettings,
} from '@/lib/subtitle-settings';

interface Props {
  settings: SubtitleSettings;
  onChange: (next: SubtitleSettings) => void;
}

/**
 * Compact settings popover for the in-player subtitle overlay. Designed to
 * stick on the right side of the player toolbar — clicking the gear toggles
 * a panel that closes when you click outside.
 *
 * We use a custom popover (instead of shadcn's) so the panel can be wider
 * than a standard dropdown and the controls (color swatches, sliders) get
 * proper layout space.
 */
export function SubtitleSettingsPopover({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Defer so the click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    document.addEventListener('keydown', onEsc);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  function patch<K extends keyof SubtitleSettings>(key: K, value: SubtitleSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  // Show a small numeric badge on the gear button when an offset is
  // active, so users can tell at a glance their subtitles are being
  // shifted (and by how much). Without this, a non-zero offset is
  // invisible until they reopen the popover.
  const offsetSecs = settings.offsetMs / 1000;
  const offsetLabel =
    settings.offsetMs === 0
      ? null
      : `${offsetSecs > 0 ? '+' : ''}${offsetSecs.toFixed(1)}s`;

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        aria-label="Subtitle settings"
        onClick={() => setOpen((v) => !v)}
        className="relative"
      >
        <SettingsIcon className="h-4 w-4" />
        {offsetLabel && (
          <span
            className="ml-1.5 inline-flex items-center rounded bg-foreground/10 px-1 py-0.5 text-[10px] font-mono font-medium tabular-nums"
            title={`Subtitle offset: ${offsetLabel}`}
          >
            {offsetLabel}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Subtitle settings"
          className="absolute right-0 top-full mt-2 z-40 w-72 rounded-md border bg-popover text-popover-foreground shadow-lg p-4 space-y-4"
        >
          <h3 className="font-semibold text-sm">Subtitle Settings</h3>

          <Field label="Font Size">
            <div className="flex flex-wrap gap-1.5">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => patch('fontSize', size)}
                  className={cn(
                    'h-8 min-w-[2.25rem] rounded-md border text-xs font-medium transition-colors',
                    size === settings.fontSize
                      ? 'bg-foreground text-background border-foreground'
                      : 'bg-background hover:bg-accent',
                  )}
                >
                  {size}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Text Color">
            <Swatches
              options={TEXT_COLORS}
              selectedId={settings.textColorId}
              onSelect={(id) => patch('textColorId', id)}
              showWhiteOutline
            />
          </Field>

          <Field label="Highlight Color">
            <Swatches
              options={HIGHLIGHT_COLORS}
              selectedId={settings.highlightColorId}
              onSelect={(id) => patch('highlightColorId', id)}
            />
          </Field>

          <ToggleRow
            label="Background"
            checked={settings.background}
            onChange={(v) => patch('background', v)}
          />
          <ToggleRow
            label="Word-by-word highlight"
            checked={settings.wordByWord}
            onChange={(v) => patch('wordByWord', v)}
          />

          <Field label="Lines Display">
            <div className="grid grid-cols-2 gap-2">
              {[1, 2].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => patch('lines', n as 1 | 2)}
                  className={cn(
                    'h-9 rounded-md border text-sm font-medium transition-colors',
                    settings.lines === n
                      ? 'bg-foreground text-background border-foreground'
                      : 'bg-background hover:bg-accent',
                  )}
                >
                  {n} {n === 1 ? 'Line' : 'Lines'}
                </button>
              ))}
            </div>
          </Field>

          <Field label={`Subtitle Offset: ${settings.offsetMs}ms`}>
            <input
              type="range"
              min={-3000}
              max={3000}
              step={50}
              value={settings.offsetMs}
              onChange={(e) => patch('offsetMs', Number(e.target.value))}
              className="w-full accent-foreground"
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1">
              <span>Earlier</span>
              <button
                type="button"
                onClick={() => patch('offsetMs', 0)}
                className="hover:text-foreground underline"
              >
                Reset
              </button>
              <span>Later</span>
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-sm">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
          checked ? 'bg-foreground' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </label>
  );
}

function Swatches({
  options,
  selectedId,
  onSelect,
  showWhiteOutline,
}: {
  options: ReadonlyArray<{ id: string; label: string; value: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  showWhiteOutline?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {options.map((c) => {
        const selected = c.id === selectedId;
        const needsOutline = showWhiteOutline && c.id === 'white';
        return (
          <button
            key={c.id}
            type="button"
            aria-label={c.label}
            title={c.label}
            onClick={() => onSelect(c.id)}
            className={cn(
              'h-7 w-7 rounded-full transition-transform hover:scale-110',
              selected ? 'ring-2 ring-offset-2 ring-foreground' : '',
              needsOutline && 'border border-input',
            )}
            style={{ backgroundColor: c.value }}
          />
        );
      })}
    </div>
  );
}
