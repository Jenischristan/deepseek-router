import { stripLeadingThink } from './parse.js';

// Streaming filter
//
// Streams normal text straight through, but holds back anything that looks
// like the start of a tool call (including a marker split across chunks) so the
// client never sees raw tool markup. Once a start marker is seen everything
// after it is held until the stream ends; the caller then parses the full text
// and decides what, if anything, to show.
//
// `holdAll` holds the whole reply (used when a tool call is mandatory, so a
// reply that turns out to be unusable can still be repaired before the client
// has seen any of it).
// ===========================================================================


const TOOL_START_RE = new RegExp(
  [
    String.raw`<(?:tool_calls?|function_calls)(?![A-Za-z0-9_])`,
    String.raw`<\/?\s*(?:[｜|]\s*){0,3}DSML(?![A-Za-z0-9_])`,
    String.raw`<invoke\s+name\s*=`,
    String.raw`<\s*[｜|]\s*tool[▁_ ]calls?[▁_ ]begin`,
  ].join('|'),
  'i',
);

// Markers that end a tool block; text after one is ordinary assistant text again.
const TOOL_END_RE = new RegExp(
  [
    String.raw`</(?:tool_calls?|function_calls)\s*>`,
    String.raw`<\/\s*(?:[｜|]\s*){0,3}DSML\s*(?:[｜|]\s*){0,3}(?:calls|function_calls|tool_calls)\s*>`,
    String.raw`<\s*[｜|]\s*tool[▁_ ]calls?[▁_ ]end\s*[｜|]\s*>`,
  ].join('|'),
  'gi',
);

const TOOL_START_MAX = 40;
const TOOL_START_LITERALS = ['<tool_call', '<tool_calls', '<function_calls', '<invoke'];
const PARTIAL_INVOKE_RE = /^<invoke\s+(?:n(?:a(?:m(?:e\s*)?)?)?)?$/;
const PARTIAL_TOKEN_LITERALS = ['dsml', 'toolcallsbegin', 'toolcallbegin'];

// Index just past the last tool-block closer in `text`, or -1 when the block
// has not finished yet. Text after that index is ordinary assistant output.
function findToolBlockEnd(text) {
  TOOL_END_RE.lastIndex = 0;
  let end = -1;
  let match;
  while ((match = TOOL_END_RE.exec(text)) !== null) end = TOOL_END_RE.lastIndex;
  return end;
}

function isPartialToolStart(suffix) {
  if (!suffix || suffix[0] !== '<' || suffix.includes('>')) return false;
  const lower = suffix.toLowerCase();
  if (TOOL_START_LITERALS.some((literal) => literal.startsWith(lower))) return true;
  if (PARTIAL_INVOKE_RE.test(lower)) return true;

  // "<｜", "<｜DS", "<｜tool▁ca" ... the start of DSML or a V3 special token.
  const piped = /^<\/?\s*[｜|]\s*([\s\S]*)$/.exec(lower);
  if (!piped) return false;
  const body = piped[1].replace(/[▁_\s｜|]/g, '');
  return body === '' || PARTIAL_TOKEN_LITERALS.some((literal) => literal.startsWith(body));
}

// Text before the first tool marker of a complete reply (what the stream
// filter would have let through), or the whole reply when it has no marker.
export function splitAtToolMarker(text) {
  const source = stripLeadingThink(text);
  const match = TOOL_START_RE.exec(source);
  return match
    ? { before: source.slice(0, match.index), found: true }
    : { before: source, found: false };
}

export class ToolCallStreamFilter {
  constructor({ holdAll = false } = {}) {
    this.buffer = '';
    this.held = '';
    this.holding = Boolean(holdAll);
  }

  push(text) {
    if (!text) return '';
    if (this.holding) {
      this.held += text;
      // Once the block closes, later text is normal output again.
      const end = findToolBlockEnd(this.held);
      if (end === -1) return '';
      const output = this.held.slice(end);
      this.held = this.held.slice(0, end);
      this.holding = false;
      return this.push(output);
    }

    this.buffer += text;
    const start = TOOL_START_RE.exec(this.buffer);
    if (start) {
      const output = this.buffer.slice(0, start.index);
      this.held = this.buffer.slice(start.index);
      this.buffer = '';
      this.holding = true;
      return output;
    }

    const lastOpen = this.buffer.lastIndexOf('<');
    if (lastOpen !== -1) {
      const suffix = this.buffer.slice(lastOpen);
      if (suffix.length <= TOOL_START_MAX && isPartialToolStart(suffix)) {
        const output = this.buffer.slice(0, lastOpen);
        this.buffer = suffix;
        return output;
      }
    }

    const output = this.buffer;
    this.buffer = '';
    return output;
  }

  get isHolding() {
    return this.holding;
  }

  takeHeld() {
    const blocks = this.held;
    // A lone "<" (or similar) that never became a marker is ordinary text.
    const pending =
      !this.holding && this.buffer.length > 1 && isPartialToolStart(this.buffer) ? '' : this.buffer;
    this.buffer = '';
    this.held = '';
    this.holding = false;
    return { blocks, pending };
  }
}
// ===========================================================================
