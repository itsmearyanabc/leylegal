import { ClassifiedIntent } from './intent.service';
import { RagService } from './rag.service';

/**
 * A general question searches the ingested judgment corpus - and in production
 * that corpus is empty (judgments come from Indian Kanoon), so the question's
 * embedding was a paid call of most of 1.4 s for a search that could only come
 * back empty (latency baseline of 4 October). It is skipped while there is
 * nothing to search, and the answer is the one the empty search led to.
 */
function service(hasChunks: boolean | Error) {
  const corpus = {
    hasJudgmentChunks: hasChunks instanceof Error ? jest.fn().mockRejectedValue(hasChunks) : jest.fn().mockResolvedValue(hasChunks),
    hybridSearch: jest.fn().mockResolvedValue([]),
    searchStatutes: jest.fn().mockResolvedValue([]),
  };
  const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const registry = { complete: jest.fn().mockResolvedValue({ text: 'answer', model: 'm', inputTokens: 1, outputTokens: 1 }) };
  const guardrails = { verify: jest.fn(async (text: string) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })) };
  const env = { RAG_DENSE_TOP_K: 20, RAG_SPARSE_TOP_K: 20, RAG_RRF_K: 60, RAG_FINAL_TOP_K: 8, RAG_MIN_RELEVANCE: 0.01 };
  const rag = new RagService(corpus as never, embeddings as never, registry as never, guardrails as never, env as never, {} as never);
  return { rag, corpus, embeddings, registry };
}

const general: ClassifiedIntent = {
  intent: 'GENERAL_LEGAL', language: 'en', cnrNumber: null, sectionNumber: null, actCode: null,
  searchQuery: 'limitation period for a cheque bounce complaint', rawText: 'What is the limitation period for filing a cheque bounce complaint?', confidence: 0.9,
};

describe('a general question with nothing ingested to search', () => {
  it('neither embeds the question nor searches, and answers as the empty search did', async () => {
    const { rag, corpus, embeddings, registry } = service(false);

    const answer = await rag.answer(general);

    expect(embeddings.embedQuery).not.toHaveBeenCalled();
    expect(corpus.hybridSearch).not.toHaveBeenCalled();
    expect(registry.complete).toHaveBeenCalledTimes(1);
    expect(answer.text).toBe('answer');
  });

  it('asks once and remembers the answer, rather than on every question', async () => {
    const { rag, corpus } = service(false);

    await rag.answer(general);
    await rag.answer(general);

    expect(corpus.hasJudgmentChunks).toHaveBeenCalledTimes(1);
  });

  it('searches as before once there are judgments to search', async () => {
    const { rag, corpus, embeddings } = service(true);

    await rag.answer(general);

    expect(embeddings.embedQuery).toHaveBeenCalledTimes(1);
    expect(corpus.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({ embedding: [0.1, 0.2] }));
  });

  it('searches as before when it cannot tell', async () => {
    const { rag, corpus } = service(new Error('connection reset'));

    await rag.answer(general);

    expect(corpus.hybridSearch).toHaveBeenCalledTimes(1);
  });
});
