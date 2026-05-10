import { useEffect, useState } from 'react';

/**
 * Returns a value that only updates after `value` has been stable for
 * `delayMs`. Useful for debouncing search inputs, URL filters, etc.
 *
 *   const [search, setSearch] = useState('');
 *   const debounced = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
 *   // fire requests against `debounced`, not `search`
 *
 * The returned reference is stable as long as the debounced value hasn't
 * changed, so it's safe to put in `useEffect` deps.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
