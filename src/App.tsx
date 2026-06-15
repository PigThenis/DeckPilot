import { useCallback, useState } from 'react';
import { useConnection } from './hooks/useConnection';
import { deckQuery } from './lib/queries';
import ConnectionStatus from './components/ConnectionStatus';
import DeckOverview from './components/DeckOverview';
import CardBrowser, { type BrowseRequest } from './components/CardBrowser';
import SuspendManager from './components/SuspendManager';
import Analytics from './components/Analytics';
import AiTagger from './components/AiTagger';

export default function App() {
  const conn = useConnection();
  const [dueToday, setDueToday] = useState<number | null>(null);
  const [browse, setBrowse] = useState<BrowseRequest | null>(null);
  const [view, setView] = useState<'dashboard' | 'browse' | 'tagging'>('dashboard');

  const handleTotals = useCallback((t: { dueToday: number }) => {
    setDueToday(t.dueToday);
  }, []);

  const handleSelectDeck = useCallback((name: string) => {
    setBrowse((b) => ({ query: deckQuery(name), label: name, nonce: (b?.nonce ?? 0) + 1 }));
    setView('browse');
  }, []);

  const connected = conn.state === 'connected';

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">DeckPilot</h1>
          <p className="text-sm text-slate-500">
            See and steer your spaced-repetition decks — without diving into the app that
            stores them.
          </p>
        </header>

        <div className="space-y-5">
          {view === 'browse' ? (
            // Card View lives on its own "page" for cleanliness — reached by
            // clicking a deck on the dashboard.
            <CardBrowser request={browse} onBack={() => setView('dashboard')} />
          ) : view === 'tagging' ? (
            <AiTagger connectedAt={conn.connectedAt} onBack={() => setView('dashboard')} />
          ) : (
            <>
              <ConnectionStatus conn={conn} />

              {/* Panels render their own connect/empty states; they only fetch once a
                  connection has been established (conn.connectedAt). When Anki drops
                  mid-session the last-known data stays on screen until the next retry. */}
              <DeckOverview
                connectedAt={conn.connectedAt}
                onTotals={handleTotals}
                onSelectDeck={handleSelectDeck}
              />

              {/* Entry point to the AI tagging page. */}
              <button
                type="button"
                onClick={() => setView('tagging')}
                className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm hover:border-sky-300"
              >
                <span>
                  <span className="block text-base font-semibold text-slate-900">
                    Auto-tag a deck with AI
                  </span>
                  <span className="block text-sm text-slate-500">
                    Give a community deck a clean, consistent tag structure — review before
                    anything is written.
                  </span>
                </span>
                <span className="shrink-0 text-sky-600">→</span>
              </button>

              <SuspendManager connectedAt={conn.connectedAt} />
              <Analytics connectedAt={conn.connectedAt} dueToday={dueToday} />
            </>
          )}
        </div>

        {view === 'dashboard' && !connected && conn.connectedAt == null && (
          <p className="mt-6 text-center text-xs text-slate-400">
            Connect to Anki above to load your decks.
          </p>
        )}

        <footer className="mt-10 border-t border-slate-200 pt-4 text-center text-xs text-slate-400">
          DeckPilot communicates with your own Anki desktop via the AnkiConnect add-on.
          It is not affiliated with, endorsed by, or derived from Anki.
        </footer>
      </div>
    </div>
  );
}
