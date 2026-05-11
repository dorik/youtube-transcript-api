'use client';

import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Single-select dropdown with a text filter. Drop-in alternative to the
 * shadcn `Select` when the option list is long enough that scanning is
 * painful (e.g. ~50 languages).
 *
 * Built on radix Popover + a plain input + keyboard navigation. Does NOT
 * depend on `cmdk` to keep the dependency footprint small.
 *
 * Usage:
 *   <SearchableSelect
 *     value={lang}
 *     onValueChange={setLang}
 *     options={LANGUAGE_OPTIONS}
 *     placeholder="Pick a language"
 *     searchPlaceholder="Search languages…"
 *   />
 */

export interface SearchableSelectOption {
  value: string;
  label: string;
}

export interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  /** Width of the dropdown content. Defaults to matching the trigger. */
  contentClassName?: string;
  /** Forwarded to the trigger button — pair with a <Label htmlFor={id}>. */
  id?: string;
  /** Accessible name when no visible label is paired. */
  'aria-label'?: string;
  /**
   * Replaces the default label text inside the trigger button. The chevron
   * is still rendered after whatever this returns. Useful for compact
   * triggers (icon + code) where the full option label would be too long.
   */
  renderTriggerLabel?: (selected: SearchableSelectOption | null) => React.ReactNode;
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyMessage = 'No matches.',
  disabled,
  className,
  contentClassName,
  id,
  'aria-label': ariaLabel,
  renderTriggerLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Reset cursor + query each time the popover opens. Focus the input.
  React.useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Radix moves focus to the trigger on close; we want the input on open.
      // requestAnimationFrame so the input is mounted before we call .focus().
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Keep the active row in view as the user arrows through results.
  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-active-row="${activeIndex}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const selected = options.find((o) => o.value === value) ?? null;

  function commit(next: SearchableSelectOption | undefined) {
    if (!next) return;
    onValueChange(next.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(filtered[activeIndex]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    }
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm',
            'ring-offset-background placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          {renderTriggerLabel ? (
            renderTriggerLabel(selected)
          ) : (
            <span className={cn('truncate text-left', !selected && 'text-muted-foreground')}>
              {selected?.label ?? placeholder}
            </span>
          )}
          <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          // Match trigger width by default — radix exposes the value via CSS var.
          className={cn(
            'z-50 w-[var(--radix-popover-trigger-width)] rounded-md border bg-popover text-popover-foreground shadow-md outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            contentClassName,
          )}
          // Don't auto-focus the first focusable child — we control focus.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div
            className="flex items-center border-b px-3"
            onKeyDown={onKeyDown}
          >
            <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder={searchPlaceholder}
              className="flex h-9 w-full bg-transparent py-3 pl-2 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel ?? placeholder}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="max-h-64 overflow-y-auto p-1"
          >
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </div>
            ) : (
              filtered.map((opt, i) => {
                const isSelected = opt.value === value;
                const isActive = i === activeIndex;
                return (
                  <div
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    data-active-row={i}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => commit(opt)}
                    className={cn(
                      'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 pr-8 text-sm outline-none',
                      isActive && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isSelected && (
                      <Check className="absolute right-2 h-4 w-4" aria-hidden="true" />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
