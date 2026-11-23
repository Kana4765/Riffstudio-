import { useEffect, useState } from 'react';

/** Reactive `window.matchMedia` match. */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Phone-sized layout (< 768px wide). */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

/** Touch-first device (Android phones/tablets). */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}
