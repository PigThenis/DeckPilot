import { useEffect, useRef, useState } from 'react';

/**
 * A typable picker: filter options as you type, and pick from a scrollable list.
 * Commits a value only on explicit selection (click / Enter), so callers don't
 * fire work on partial text. Syncs its display when `value` changes externally.
 */
export default function Combobox({
  options,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  const MAX = 200;
  const shown = filtered.slice(0, MAX);

  function commit(v: string) {
    onChange(v);
    setQuery(v);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(shown.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      if (open && shown[highlight]) {
        e.preventDefault();
        commit(shown[highlight]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          {shown.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-400">No matches</div>
          ) : (
            <ul className="max-h-60 overflow-auto">
              {shown.map((o, i) => (
                <li key={o}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => commit(o)}
                    className={`block w-full truncate px-3 py-1.5 text-left text-sm ${
                      i === highlight ? 'bg-sky-50 text-sky-800' : 'text-slate-700'
                    }`}
                    title={o}
                  >
                    {o}
                  </button>
                </li>
              ))}
              {filtered.length > MAX && (
                <li className="px-3 py-1.5 text-xs text-slate-400">
                  +{filtered.length - MAX} more — keep typing to narrow…
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
