import assert from 'node:assert/strict';
import test from 'node:test';

import { ChallengeError, UpstreamError } from '../src/errors.js';
import { consumeDeepSeekStream, fragmentsText } from '../src/openai/sse.js';

function stream(events) {
  const lines = [];
  for (const [name, data] of events) {
    lines.push(`event: ${name}`, `data: ${JSON.stringify(data)}`, '');
  }
  return new Response(lines.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('routes non-response fragments to reasoning', async () => {
  const result = await consumeDeepSeekStream(
    stream([
      [
        'update',
        {
          v: {
            response: {
              status: 'FINISHED',
              fragments: [
                { type: 'THINK', content: 'thinking' },
                { type: 'SEARCH', content: 'search notes' },
                { type: 'RESPONSE', content: 'answer' },
              ],
            },
          },
        },
      ],
    ]),
  );
  assert.deepEqual(fragmentsText(result.fragments), {
    content: 'answer',
    reasoning: 'thinkingsearch notes',
  });
});

test('streams only the appended part of a SET patch', async () => {
  const deltas = [];
  const result = await consumeDeepSeekStream(
    stream([
      ['update', { v: { response: { status: 'FINISHED', fragments: [{ content: 'Hel' }] } } }],
      ['update', { p: 'response/fragments/0/content', o: 'SET', v: 'Hello' }],
    ]),
    { onDelta: (field, text) => deltas.push([field, text]) },
  );
  assert.deepEqual(deltas, [
    ['content', 'Hel'],
    ['content', 'lo'],
  ]);
  assert.equal(result.fragments[0].content, 'Hello');
});

test('throws a rate-limit UpstreamError for a hint error', async () => {
  await assert.rejects(
    consumeDeepSeekStream(
      stream([
        [
          'hint',
          { type: 'error', finish_reason: 'rate_limit_reached', content: 'slow down' },
        ],
      ]),
    ),
    (error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.equal(error.code, 'rate_limit_reached');
      return true;
    },
  );
});

test('throws a ChallengeError when the stream asks for verification', async () => {
  await assert.rejects(
    consumeDeepSeekStream(
      stream([
        [
          'hint',
          {
            type: 'error',
            finish_reason: 'challenge_required',
            content: 'CHALLENGE_REQUIRED',
          },
        ],
      ]),
    ),
    (error) => {
      assert.ok(error instanceof ChallengeError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'challenge_required');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('throws an UpstreamError for stream error events', async () => {
  await assert.rejects(
    consumeDeepSeekStream(stream([['error', { message: 'upstream failed', code: 7 }]])),
    (error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.message, 'upstream failed');
      assert.equal(error.code, 7);
      return true;
    },
  );
});

test('throws for a non-zero code payload', async () => {
  await assert.rejects(
    consumeDeepSeekStream(stream([['update', { code: 5, msg: 'bad request' }]])),
    /bad request/,
  );
});
