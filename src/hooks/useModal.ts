import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/**
 * Shared modal behaviour: focus moves into the panel when it opens, Tab and
 * Shift+Tab wrap inside it, Escape closes it, the page behind does not scroll,
 * and focus returns to whatever opened it. Both the drawer and the privacy
 * dialog used to implement part of this; missing any one of them is what makes
 * a modal feel like a panel floating over a page that is still reachable.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Two modals cannot be open at once here, but React can mount an effect twice
// (StrictMode), so the lock counts instead of overwriting the inline style.
let scrollLocks = 0;
let previousOverflow = '';

function lockScroll(): void {
  if (scrollLocks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks += 1;
}

function unlockScroll(): void {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = previousOverflow;
}

export interface Modal<T extends HTMLElement = HTMLElement> {
  /** Attach to the element carrying `role="dialog"`. */
  ref: RefObject<T | null>;
  /** Attach to the same element: it is where the Tab wrap happens. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useModal<T extends HTMLElement = HTMLElement>(
  open: boolean,
  onClose: () => void,
): Modal<T> {
  const ref = useRef<T | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Callers pass a fresh arrow function on every render; the effect must not
  // restart (and steal focus back) just because of that.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    openerRef.current = opener instanceof HTMLElement ? opener : null;
    // The panel itself is the target: screen readers announce its label, and
    // Tab starts at the first control instead of the middle of the dialog.
    ref.current?.focus();
    lockScroll();

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      unlockScroll();
      const previous = openerRef.current;
      openerRef.current = null;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const root = ref.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => node.getClientRects().length > 0,
    );
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) {
      event.preventDefault();
      root.focus();
      return;
    }
    const active = document.activeElement;
    if (!(active instanceof Node) || !root.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return { ref, onKeyDown };
}
