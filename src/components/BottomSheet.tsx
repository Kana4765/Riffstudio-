import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

interface BottomSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Mobile slide-up drawer with backdrop, grab handle, safe-area padding and Escape to close. */
export function BottomSheet({ open, title, onClose, children }: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div className="sheet-backdrop absolute inset-0 bg-black/55" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-panel relative flex max-h-[82dvh] flex-col rounded-t-2xl border-t border-ink-600 bg-ink-900 shadow-2xl"
      >
        <button type="button" aria-label={`Close ${title}`} onClick={onClose} className="flex h-6 w-full shrink-0 items-center justify-center">
          <span className="h-1.5 w-12 rounded-full bg-ink-500" />
        </button>
        <div className="flex shrink-0 items-center justify-between px-4 pb-2">
          <h2 className="text-sm font-bold tracking-wide text-zinc-100">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-xl text-mist-400 hover:bg-ink-700"
          >
            <X size={18} />
          </button>
        </div>
        <div className="touch-pan min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </div>
  );
}
