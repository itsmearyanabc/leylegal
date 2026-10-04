import { AIMessageChunk } from '@langchain/core/messages';
import { LangChainProvider } from './langchain.provider';
import { LlmProvider, LlmRequest } from './llm-provider.interface';
import { ProviderRegistry } from './provider.registry';

/**
 * Streaming an answer must not change it: the same request, and the same text
 * back as complete() gives for the same generation (draft-release.ts).
 *
 * The text is a real answer (leylegal.in, 4 October 2026, question X3), cut
 * into pieces the way a model sends it.
 */
const X3 =
  "*SECTION:* CrPC Section 167, mapped to BNSS Section 187.\n\n*SUMMARY:* CrPC 167, now BNSS 187, allows a Magistrate to authorize detention when an investigation isn't finished within 24 hours.";

const request: LlmRequest = {
  task: 'synthesis',
  system: 'You are a legal research assistant.',
  messages: [{ role: 'user', content: 'CrPC 167 default bail — which BNSS section now?' }],
};

function provider() {
  const env = { OPENAI_API_KEY: 'test', OPENAI_SYNTHESIS_MODEL: 'gpt-4.1', OPENAI_ROUTER_MODEL: 'gpt-4.1-mini', LLM_TIMEOUT_MS: 45_000, LLM_MAX_RETRIES: 2 };
  const llm = new LangChainProvider('openai', 'synthesis', env as never);
  const pieces = X3.match(/[\s\S]{1,11}/g)!;
  const model = {
    invoke: jest.fn(),
    stream: jest.fn(async () =>
      (async function* () {
        for (const [i, piece] of pieces.entries()) {
          yield new AIMessageChunk({
            content: piece,
            ...(i === pieces.length - 1 ? { usage_metadata: { input_tokens: 812, output_tokens: 74, total_tokens: 886 } } : {}),
          });
        }
      })(),
    ),
  };
  (llm as unknown as { model: unknown }).model = model;
  return { llm, model };
}

describe('a streamed answer', () => {
  it('is the same text, reported as it grows, with the usage of the whole', async () => {
    const { llm, model } = provider();
    const seen: string[] = [];

    const result = await llm.stream(request, (written) => seen.push(written));

    expect(result.text).toBe(X3);
    expect(result.inputTokens).toBe(812);
    expect(result.outputTokens).toBe(74);
    expect(seen[seen.length - 1]).toBe(X3);
    for (let i = 1; i < seen.length; i++) expect(seen[i].startsWith(seen[i - 1])).toBe(true);

    const [messages, options] = model.stream.mock.calls[0] as unknown as [{ content: string }[], unknown];
    expect(messages.map((m) => m.content)).toEqual([request.system, request.messages[0].content]);
    expect(options).toBeUndefined();
  });
});

describe('the registry', () => {
  function registry(synthesis: LlmProvider) {
    const mock = { name: 'mock', complete: jest.fn().mockResolvedValue({ text: 'mock', model: 'mock', inputTokens: 0, outputTokens: 0, mocked: true }) };
    const r = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    Object.assign(r, { synthesis, router: synthesis, mock, logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } });
    return r;
  }

  it('asks a provider that cannot stream exactly as before', async () => {
    const complete = jest.fn().mockResolvedValue({ text: X3, model: 'p', inputTokens: 1, outputTokens: 1 });
    const onText = jest.fn();

    const result = await registry({ name: 'p', complete }).completeStreaming(request, onText);

    expect(result.text).toBe(X3);
    expect(complete).toHaveBeenCalledWith(request);
    expect(onText).not.toHaveBeenCalled();
  });

  it('withdraws what it reported and answers in one piece when the stream fails part-way', async () => {
    const complete = jest.fn().mockResolvedValue({ text: X3, model: 'p', inputTokens: 1, outputTokens: 1 });
    const stream = jest.fn(async (_r: LlmRequest, onText: (w: string) => void) => {
      onText(X3.slice(0, 20));
      throw new Error('socket hang up');
    });
    const reported: string[] = [];

    const result = await registry({ name: 'p', complete, stream }).completeStreaming(request, (w) => reported.push(w));

    expect(reported).toEqual([X3.slice(0, 20), '']);
    expect(result.text).toBe(X3);
    expect(complete).toHaveBeenCalledWith(request);
  });
});
