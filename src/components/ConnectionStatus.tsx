import type { Connection } from '../hooks/useConnection';

function Dot({ color }: { color: string }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

/** Panel A — live connection indicator + version + retry + contextual help. */
export default function ConnectionStatus({ conn }: { conn: Connection }) {
  const { state, apiVersion, message, retry } = conn;

  const connected = state === 'connected';
  const checking = state === 'checking';

  let dotColor = 'bg-slate-300';
  let label = 'Checking…';
  if (connected) {
    dotColor = 'bg-emerald-500';
    label = 'Connected';
  } else if (checking) {
    dotColor = 'bg-amber-400 animate-pulse';
    label = 'Checking…';
  } else {
    dotColor = 'bg-rose-500';
    label = 'Not connected';
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Dot color={dotColor} />
          <div>
            <p className="text-sm font-semibold text-slate-900">{label}</p>
            {connected && apiVersion != null && (
              <p className="text-xs text-slate-500">AnkiConnect API v{apiVersion}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={retry}
          disabled={checking}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Retry'}
        </button>
      </div>

      {!connected && !checking && (
        <div className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
          {state === 'cors' ? (
            <div>
              <p className="font-medium text-slate-800">
                Your browser blocked the connection to Anki.
              </p>
              <p className="mt-1">
                If you are running the app with <code>npm run dev</code> this should not
                happen. If you built or deployed the app, open Anki →{' '}
                <span className="font-medium">Tools → Add-ons → AnkiConnect → Config</span>{' '}
                and add this app's address to <code>webCorsOriginList</code>, then restart
                Anki.
              </p>
            </div>
          ) : (
            <div>
              <p className="font-medium text-slate-800">
                Open Anki on your computer to get started.
              </p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>Launch the Anki desktop app and leave it running.</li>
                <li>
                  Make sure the AnkiConnect add-on is installed (add-on code{' '}
                  <code className="rounded bg-slate-200 px-1">2055492159</code>).
                </li>
                <li>Click Retry above.</li>
              </ol>
            </div>
          )}
          {message && <p className="mt-3 text-xs text-slate-400">Details: {message}</p>}
        </div>
      )}
    </section>
  );
}
