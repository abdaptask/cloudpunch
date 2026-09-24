import { useEffect, type RefObject } from 'react';
import { api } from './api.js';

/**
 * Keep the main window sized to its content: whenever the element's
 * height changes (clock in/out, a session expanding, a notice
 * appearing) ask the agent to resize. The agent clamps to the screen;
 * beyond that the page scrolls.
 *
 * No-op where ResizeObserver is missing (jsdom) or outside Tauri.
 */
export function useFitWindow(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = Math.ceil(el.getBoundingClientRect().height);
        if (Math.abs(height - last) < 2) return;
        last = height;
        api.fitWindow(height).catch(() => undefined);
      });
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
}
