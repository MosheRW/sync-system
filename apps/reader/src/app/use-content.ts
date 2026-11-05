import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentError } from '../content/errors.js';
import type { ContentLoader, ContentSource, LoadedContent } from '../content/loader.js';

export type ContentState =
  | { status: 'loading'; showIndicator: boolean; stillLoading: boolean }
  | { status: 'ready'; content: LoadedContent; afterRetry: boolean }
  | { status: 'error'; error: ContentError; retrying: boolean };

export const LOADING_INDICATOR_DELAY_MS = 300;
export const STILL_LOADING_DELAY_MS = 8000;

/**
 * Runs the loader for one source (design.md section 8): no indicator for
 * the first 300 ms, "still loading" after 8 s when the timeout is longer,
 * `retry()` for fetch failures. Aborts on unmount; aborted results are
 * ignored.
 */
export function useContent(
  loader: ContentLoader,
  source: ContentSource,
  fetchTimeoutSeconds: number,
): { state: ContentState; retry: () => void } {
  const [state, setState] = useState<ContentState>({
    status: 'loading',
    showIndicator: false,
    stillLoading: false,
  });
  const controllerRef = useRef<AbortController | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  };

  const run = useCallback(
    (isRetry: boolean) => {
      controllerRef.current?.abort();
      clearTimers();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (!isRetry) {
        timersRef.current.push(
          setTimeout(() => {
            setState((s) => (s.status === 'loading' ? { ...s, showIndicator: true } : s));
          }, LOADING_INDICATOR_DELAY_MS),
        );
        if (fetchTimeoutSeconds * 1000 > STILL_LOADING_DELAY_MS) {
          timersRef.current.push(
            setTimeout(() => {
              setState((s) => (s.status === 'loading' ? { ...s, stillLoading: true } : s));
            }, STILL_LOADING_DELAY_MS),
          );
        }
      }

      void loader.load(source, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;
        clearTimers();
        if (result.ok) {
          setState({ status: 'ready', content: result.content, afterRetry: isRetry });
        } else if (result.error.kind !== 'aborted') {
          setState({ status: 'error', error: result.error, retrying: false });
        }
      });
    },
    [loader, source, fetchTimeoutSeconds],
  );

  useEffect(() => {
    run(false);
    return () => {
      controllerRef.current?.abort();
      clearTimers();
    };
  }, [run]);

  const retry = useCallback(() => {
    setState((s) => (s.status === 'error' ? { ...s, retrying: true } : s));
    run(true);
  }, [run]);

  return { state, retry };
}
