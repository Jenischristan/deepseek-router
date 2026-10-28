import { stripLeadingThink } from './parse.js';

// Streaming filter
//
// Streams normal text straight through, but holds back anything that looks
// like the start of a tool call (including a marker split across chunks) so the
// client never sees raw tool markup. Once a start marker is seen the rest of
// the reply is held until the stream ends; the caller parses the full text and
// decides what, if anything, to show.
//
// Holding the whole tail (instead of releasing text after the first closer) is
// deliberate: multiple blocks, a closer inside a JSON string, V3 end tokens and
// block-less DSML are all impossible to delimit reliably while the stream is
// still arriving. The final parser has the complete text, so it is the only
// place that should decide where a block ends.
//
// `holdAll` holds the whole reply (used when a tool call is mandatory, so a
// reply that turns out to be unusable can still be repaired before the client
// has seen any of it).
// ===========================================================================

const TOOL_START_RE = new RegExp(
  [
    String.raw`<(?:tool_calls?|function_calls?|tool_uses?)(?![A-Za-z0-9_])`,
    String.raw`<\/?\s*(?:[｜|]\s*){0,3}DSML(?![A-Za-z0-9_])`,
    String.raw`<invoke\s+name\s*=`,
    String.raw`<\s*[｜|]\s*tool[▁_ ]calls?[▁_ ]begin`,
    String.raw`<\s*[｜|]\s*tool[▁_ ]outputs?[▁_ ]begin`,
  ].join('|'),
  'i',
);

const TOOL_START_MAX = 80;
const TOOL_START_LITERALS = [
  '<tool_call',
  '<tool_calls',
  '<function_call',
  '<function_calls',
  '<tool_use',
  '<tool_uses',
  '<invoke',
];
const PARTIAL_INVOKE_RE = /^<\s*\/?\s*invoke\s*(?:n(?:a(?:m(?:e(?:\s*=\s*)?)?)?)?)?$/;
const PARTIAL_TOKEN_LITERALS = [
  'dsml',
  'toolcallsbegin',
  'toolcallbegin',
  'tooloutputsbegin',
  'tooloutputbegin',
];

// Absolute index of a Markdown fence opener that immediately precedes `start`
// (````xml\n<tool_call>````), or -1. Keeping the opener in the held/generated
// text lets the parser consume the whole fenced block instead of leaving
// "```xml" in the assistant content.
export function fenceOpenAt(text, start) {
  const from = Math.max(0, start - 96);
  const prefix = text.slice(from, start);
  const fence = prefix.lastIndexOf('```');
  if (fence === -1) return -1;
  const tail = prefix.slice(fence);
  if (!/^```[A-Za-z0-9_+.-]*[ \t]*(?:\r?\n[ \t]*)?$/.test(tail)) return -1;
  return from + fence;
}

// Index of a fence opener still waiting for its first content line.
function trailingFenceOpen(text) {
  const fence = text.lastIndexOf('```');
  if (fence === -1) return -1;
  const tail = text.slice(fence);
  return /^```[A-Za-z0-9_+.-]*[ \t]*(?:\r?\n[ \t]*)?$/.test(tail) ? fence : -1;
}

function isPartialToolStart(suffix) {
  if (!suffix || suffix[0] !== '<' || suffix.includes('>')) return false;
  const lower = suffix.toLowerCase();
  if (lower === '<' || lower === '</' || lower.trim() === '</') return true;

  // "<｜", "<｜DS", "<｜tool▁ca", "</｜DSML calls" ...
  const piped = /^<\/?\s*[｜|]\s*([\s\S]*)$/.exec(lower);
  if (piped) {
    const body = piped[1].replace(/[▁_\s｜|]/g, '');
    return body === '' || PARTIAL_TOKEN_LITERALS.some((literal) => literal.startsWith(body));
  }

  // "<tool_", "<function_c", "</tool_call" ...
  const plain = lower.replace(/^<\s*\/?\s*/, '');
  if (!plain) return true;
  const compact = plain.replace(/\s+/g, '');
  if (TOOL_START_LITERALS.some((literal) => literal.slice(1).startsWith(plain))) return true;
  if (TOOL_START_LITERALS.some((literal) => literal.slice(1).startsWith(compact))) return true;
  return PARTIAL_INVOKE_RE.test(lower);
}

// Text before the first tool marker of a complete reply (what the stream
// filter would have let through), or the whole reply when it has no marker.
// A fence immediately wrapping the marker belongs to the block, not the prose.
export function splitAtToolMarker(text) {
  const source = stripLeadingThink(text);
  const match = TOOL_START_RE.exec(source);
  if (!match) return { before: source, found: false };
  const fence = fenceOpenAt(source, match.index);
  const index = fence !== -1 ? fence : match.index;
  return { before: source.slice(0, index), found: true };
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
      return '';
    }

    this.buffer += text;

    const start = TOOL_START_RE.exec(this.buffer);
    if (start) {
      const fence = fenceOpenAt(this.buffer, start.index);
      const index = fence !== -1 ? fence : start.index;
      const output = this.buffer.slice(0, index);
      // Append rather than replace: a second block may arrive in a later chunk.
      this.held += this.buffer.slice(index);
      this.buffer = '';
      this.holding = true;
      return output;
    }

    const lastOpen = this.buffer.lastIndexOf('<');
    if (lastOpen !== -1) {
      const suffix = this.buffer.slice(lastOpen);
      if (suffix.length <= TOOL_START_MAX && isPartialToolStart(suffix)) {
        const fence = fenceOpenAt(this.buffer, lastOpen);
        const index = fence !== -1 ? fence : lastOpen;
        const output = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index);
        return output;
      }
    }

    // Do not stream a fence opener until we know whether the block it opens is
    // a tool call. Otherwise "```xml\n<tool_call>" would leak the opener.
    const fence = trailingFenceOpen(this.buffer);
    if (fence !== -1) {
      const output = this.buffer.slice(0, fence);
      this.buffer = this.buffer.slice(fence);
      return output;
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
    // A lone "<" (or similar) that never became a marker is ordinary text; a
    // longer partial marker is markup and must not be shown.
    const pending =
      !this.holding && this.buffer.length > 1 && isPartialToolStart(this.buffer)
        ? ''
        : this.buffer;
    this.buffer = '';
    this.held = '';
    this.holding = false;
    return { blocks, pending };
  }
}
// ===========================================================================
