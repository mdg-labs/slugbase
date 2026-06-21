import { useCallback, useEffect, useRef, useState } from "react";

export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    const activeRef = { current: true };
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await loaderRef.current();
        if (activeRef.current) {
          setData(result);
        }
      } catch (caught) {
        if (activeRef.current) {
          const message =
            caught instanceof Error ? caught.message : "Request failed";
          setError(message);
          setData(null);
        }
      } finally {
        if (activeRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      activeRef.current = false;
    };
  }, [tick, ...deps]);

  return { data, loading, error, reload };
}
