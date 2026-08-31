import { NlOllamaConfig } from '../../models/types';
import { FIELD_NAMES } from './parse';

/**
 * The §9.6 Ollama passthrough — the ONLY network call the natural-language
 * box can cause, and it lives in its own file so that claim is auditable at
 * a glance: no other module under query/ imports fetch-shaped anything.
 *
 * Three properties the tests hold directly:
 *
 *  - **Off means off.** The route checks `enabled` before calling here, and
 *    this function refuses again if handed a disabled config — with it off,
 *    zero network code runs, proven by a recorder server in the tests.
 *  - **Never trusted.** Whatever the model answers is returned as text for
 *    the ROUTE to validate through the real grammar's parse(). A model that
 *    answers garbage is refused; its words never reach the user as a
 *    runnable query.
 *  - **Never executes.** This translates. Execution stays a separate,
 *    human-initiated step after the translated query has been shown.
 */

/** Keep a slow model from pinning the request forever. */
const OLLAMA_TIMEOUT_MS = 12_000;
/** A model that rambles past this is not answering the question. */
const MAX_ANSWER_CHARS = 500;

export interface OllamaAnswer {
  ok: boolean;
  /** The model's candidate query — UNVALIDATED; the caller must parse it. */
  q?: string;
  reason?: string;
}

export async function translateViaOllama(text: string, cfg: NlOllamaConfig): Promise<OllamaAnswer> {
  if (!cfg.enabled) {
    // Belt and braces: the route already gates on this. Refusing here too
    // means a future caller cannot reach the network by forgetting the check.
    return { ok: false, reason: 'The local model is switched off in Settings.' };
  }
  if (!cfg.model) {
    return { ok: false, reason: 'Pick a model name in Settings first (for example "llama3.2").' };
  }

  const prompt =
    'Translate the request into one line in this exact file-search query language and output ONLY that line.\n' +
    `Fields: ${FIELD_NAMES.join(', ')}.\n` +
    'Syntax examples: size>1gb · size<=500mb · ext:mp4,mov · name:report · in:~/Downloads · ' +
    '-in:node_modules · modified>90d · used>1y · used:never · dupe:yes · backup:no · ' +
    'cloud:local-only · git:pushed · type:file · empty:yes · score>70. Terms are ANDed.\n' +
    `Request: ${text}\n` +
    'Query:';

  try {
    const res = await fetch(`${cfg.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, prompt, stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: `The local model at ${cfg.endpoint} answered ${res.status}. Is Ollama running, and is "${cfg.model}" pulled?` };
    }
    const data = (await res.json()) as { response?: unknown };
    // First non-empty line only: models love to add prose, and everything
    // past the query line is prose by construction of the prompt.
    const raw = typeof data.response === 'string' ? data.response : '';
    const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    if (!line) {
      return { ok: false, reason: 'The local model answered nothing usable.' };
    }
    return { ok: true, q: line.slice(0, MAX_ANSWER_CHARS) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Could not reach the local model at ${cfg.endpoint} (${msg}).` };
  }
}
