// ---------------------------------------------------------------------------
// The ONLY place in the app that talks to AnkiConnect.
//
// LEGAL NOTE: This app communicates with the user's own running Anki desktop
// strictly over AnkiConnect's documented HTTP API, as a separate process at
// arm's length. It does NOT import, bundle, vendor, or link any Anki / rslib
// source code. Keep it that way — Anki's desktop code is AGPL-3.0 and linking
// it would impose network-copyleft on this codebase.
//
// Transport is isolated here so it can be swapped later without touching the UI.
// ---------------------------------------------------------------------------

/** Default transport: the same-origin Vite proxy path (see vite.config.ts). */
const DEFAULT_BASE_URL = '/anki';

let baseUrl = DEFAULT_BASE_URL;

/** Override the AnkiConnect endpoint (e.g. a direct http://127.0.0.1:8765). */
export function setBaseUrl(url: string): void {
  baseUrl = url || DEFAULT_BASE_URL;
}

export function getBaseUrl(): string {
  return baseUrl;
}

/** Categorised failure so the UI can give the right fix for each case. */
export type AnkiErrorKind = 'offline' | 'cors' | 'logic' | 'unknown';

export class AnkiError extends Error {
  kind: AnkiErrorKind;
  constructor(kind: AnkiErrorKind, message: string) {
    super(message);
    this.name = 'AnkiError';
    this.kind = kind;
  }
}

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

// AnkiConnect is synchronous and single-threaded: overlapping requests contend,
// and a heavy call (e.g. getDeckStats over hundreds of decks) can make sibling
// calls fail or time out. We serialise every call through one promise chain so
// at most one request is ever in flight. Each call waits for the previous to
// settle; a failure never breaks the chain for the next call.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Single choke-point for every AnkiConnect call. Serialises requests, adds
 * version:6, performs the POST, and checks `error` first (AnkiConnect returns
 * HTTP 200 even on logical errors). Throws a categorised AnkiError on failure.
 */
export function invoke<T = unknown>(
  action: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return enqueue(() => doInvoke<T>(action, params));
}

async function doInvoke<T>(action: string, params: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch (e) {
    // A thrown fetch means the request never completed: either Anki/AnkiConnect
    // isn't reachable (connection refused) or the browser blocked it (CORS).
    // We can't always tell them apart from JS, but the message hints at it.
    const msg = e instanceof Error ? e.message : String(e);
    const kind: AnkiErrorKind = /cors/i.test(msg) ? 'cors' : 'offline';
    throw new AnkiError(
      kind,
      kind === 'cors'
        ? 'The request to Anki was blocked (CORS). See the connection panel for the fix.'
        : 'Could not reach Anki. Is Anki open with the AnkiConnect add-on installed?'
    );
  }

  if (!res.ok) {
    // With the Vite proxy transport, a 5xx means the proxy itself couldn't reach
    // AnkiConnect (e.g. ECONNREFUSED because Anki is closed) — treat as offline so
    // the user gets the "open Anki" guidance rather than a raw status code.
    if (res.status >= 500) {
      throw new AnkiError(
        'offline',
        'Could not reach Anki. Is Anki open with the AnkiConnect add-on installed?'
      );
    }
    throw new AnkiError('unknown', `AnkiConnect responded with HTTP ${res.status}.`);
  }

  let body: AnkiResponse<T>;
  try {
    body = (await res.json()) as AnkiResponse<T>;
  } catch {
    throw new AnkiError('unknown', 'AnkiConnect returned a response that was not valid JSON.');
  }

  if (body.error != null) {
    throw new AnkiError('logic', body.error);
  }

  return body.result;
}

// ---------------------------------------------------------------------------
// Thin, typed wrappers per action. The UI calls these — never invoke() directly.
// ---------------------------------------------------------------------------

export interface DeckStat {
  deck_id: number;
  name: string;
  new_count: number;
  learn_count: number;
  review_count: number;
  total_in_deck: number;
}

/** Connection check. Returns the AnkiConnect API version number. */
export function version(): Promise<number> {
  return invoke<number>('version');
}

/** All deck names. */
export function deckNames(): Promise<string[]> {
  return invoke<string[]>('deckNames');
}

/** Map of deck name -> deck id. */
export function deckNamesAndIds(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>('deckNamesAndIds');
}

/** Per-deck new/learn/review counts, keyed by deck id (as a string). */
export function getDeckStats(decks: string[]): Promise<Record<string, DeckStat>> {
  if (decks.length === 0) return Promise.resolve({});
  return invoke<Record<string, DeckStat>>('getDeckStats', { decks });
}

/** Every tag in the collection. */
export function getTags(): Promise<string[]> {
  return invoke<string[]>('getTags');
}

/** Card IDs matching an Anki search query. Can be very large — use length for counts. */
export function findCards(query: string): Promise<number[]> {
  return invoke<number[]>('findCards', { query });
}

/** Note IDs matching an Anki search query (tagging operates on notes, not cards). */
export function findNotes(query: string): Promise<number[]> {
  return invoke<number[]>('findNotes', { query });
}

/** Add space-separated tags to the given notes. */
export function addTags(notes: number[], tags: string): Promise<null> {
  if (notes.length === 0) return Promise.resolve(null);
  return invoke<null>('addTags', { notes, tags });
}

/** Remove space-separated tags from the given notes. */
export function removeTags(notes: number[], tags: string): Promise<null> {
  if (notes.length === 0) return Promise.resolve(null);
  return invoke<null>('removeTags', { notes, tags });
}

/** A single field's value plus its display order within the note. */
export interface FieldValue {
  value: string;
  order: number;
}

export interface CardInfo {
  cardId: number;
  /** The note this card belongs to. */
  note: number;
  /** Rendered front (question) HTML — from Anki's card template. */
  question: string;
  /** Rendered back (answer) HTML — from Anki's card template. */
  answer: string;
  fields: Record<string, FieldValue>;
  fieldOrder: number;
  modelName: string;
  deckName: string;
}

/**
 * Full details for specific cards (rendered question/answer + fields). Only ever
 * call this on a single page of IDs — never the whole deck.
 */
export function cardsInfo(cards: number[]): Promise<CardInfo[]> {
  if (cards.length === 0) return Promise.resolve([]);
  return invoke<CardInfo[]>('cardsInfo', { cards });
}

export interface NoteInfo {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, FieldValue>;
}

/** Note-level details (tags, note type, fields) for specific notes. */
export function notesInfo(notes: number[]): Promise<NoteInfo[]> {
  if (notes.length === 0) return Promise.resolve([]);
  return invoke<NoteInfo[]>('notesInfo', { notes });
}

/**
 * Base64 contents of a file in the collection.media folder, or false if absent.
 * Read-only — used to inline card images as data URIs in the sandboxed preview.
 */
export function retrieveMediaFile(filename: string): Promise<string | false> {
  return invoke<string | false>('retrieveMediaFile', { filename });
}

/** Suspended state per card id, in the same order as the input. */
export function areSuspended(cards: number[]): Promise<(boolean | null)[]> {
  if (cards.length === 0) return Promise.resolve([]);
  return invoke<(boolean | null)[]>('areSuspended', { cards });
}

/** Suspend the given card ids. */
export function suspend(cards: number[]): Promise<boolean> {
  if (cards.length === 0) return Promise.resolve(true);
  return invoke<boolean>('suspend', { cards });
}

/** Unsuspend the given card ids. */
export function unsuspend(cards: number[]): Promise<boolean> {
  if (cards.length === 0) return Promise.resolve(true);
  return invoke<boolean>('unsuspend', { cards });
}

/** Number of cards reviewed today across the whole collection. */
export function getNumCardsReviewedToday(): Promise<number> {
  return invoke<number>('getNumCardsReviewedToday');
}

// ---------------------------------------------------------------------------
// Helpers for large collections.
// ---------------------------------------------------------------------------

/**
 * Split the given cards into currently-active and currently-suspended id lists,
 * fetching suspended state in batches to avoid blocking AnkiConnect on huge ID
 * lists. Cards whose state can't be read are treated as active (safe default:
 * a suspend call on them is a no-op, an unsuspend simply ensures they're on).
 */
export async function partitionSuspended(
  cards: number[],
  batchSize = 1000
): Promise<{ active: number[]; suspended: number[] }> {
  const active: number[] = [];
  const suspended: number[] = [];
  for (let i = 0; i < cards.length; i += batchSize) {
    const batch = cards.slice(i, i + batchSize);
    const states = await areSuspended(batch);
    batch.forEach((id, j) => {
      if (states[j] === true) suspended.push(id);
      else active.push(id);
    });
  }
  return { active, suspended };
}
