import { useCallback, useEffect, useState } from 'react';
import { AnkiError, version } from '../lib/anki';

export type ConnectionState = 'checking' | 'connected' | 'offline' | 'cors' | 'error';

export interface Connection {
  state: ConnectionState;
  apiVersion: number | null;
  message: string | null;
  /** Re-run the connection check. */
  retry: () => void;
  /** Bumps each time a successful check completes — lets panels know to refetch. */
  connectedAt: number | null;
}

/**
 * Owns the live connection status. Calls `version` on mount and on demand, and
 * categorises failures (offline vs CORS vs other) so the UI can show the right
 * fix. Never throws to the caller.
 */
export function useConnection(): Connection {
  const [state, setState] = useState<ConnectionState>('checking');
  const [apiVersion, setApiVersion] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  const check = useCallback(async () => {
    setState('checking');
    setMessage(null);
    try {
      const v = await version();
      setApiVersion(v);
      setState('connected');
      setConnectedAt(Date.now());
    } catch (e) {
      setApiVersion(null);
      if (e instanceof AnkiError) {
        if (e.kind === 'offline') setState('offline');
        else if (e.kind === 'cors') setState('cors');
        else setState('error');
        setMessage(e.message);
      } else {
        setState('error');
        setMessage(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return { state, apiVersion, message, retry: () => void check(), connectedAt };
}
