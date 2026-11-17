import { stripAnsi } from './ansi.ts';

// Unicode bidirectional embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069).
// A terminal that applies them shows a row in an order different from the text it holds, so a
// file line or a command shown for review could read as something else.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

// Text from files, commands, tools and providers, cleaned to be written to the terminal: escape
// sequences, control bytes and bidirectional controls are removed, and so are carriage returns,
// which would overwrite the start of the row.
export const terminalText = (text: string): string =>
  stripAnsi(text).replace(/\r/g, '').replace(BIDI_CONTROLS, '');
