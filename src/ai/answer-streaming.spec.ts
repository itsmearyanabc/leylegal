import { GuardrailsService } from './guardrails.service';
import { ClassifiedIntent } from './intent.service';
import { LlmRequest } from './providers/llm-provider.interface';
import { RagDraft, RagService, RagStage } from './rag.service';

/**
 * The web chat is shown the answer as it is written; WhatsApp, which sends one
 * message, asks exactly as before. The answer is real (leylegal.in,
 * 4 October 2026, X3).
 */
const X3 =
  "*SECTION:* CrPC Section 167, mapped to BNSS Section 187.\n\n*SUMMARY:* CrPC 167, now BNSS 187, allows a Magistrate to authorize detention when an investigation isn't finished within 24 hours. If detention exceeds 60 or 90 days depending on the offence's seriousness, the accused must be released on bail unless they cannot furnish it.\n\n*KEY ELEMENTS:*  \n- Detention for investigation: Max 90 days (grave offences), 60 days (other offences).  \n- Cognizable: Yes  \n- Compoundable: No\n\n*PRACTICAL USE:* Advocates use this to argue for the release of clients on 'default bail' when the police fail to file a charge sheet within the stipulated period.";

const general: ClassifiedIntent = {
  intent: 'GENERAL_LEGAL', language: 'en', cnrNumber: null, sectionNumber: null, actCode: null,
  searchQuery: 'default bail', rawText: 'CrPC 167 default bail — which BNSS section now?', confidence: 0.9,
};

function service() {
  const corpus = {
    verifyCitations: jest.fn(async (citations: string[]) => citations.map((citation) => ({ citation, found: false }))),
    verifyStatuteRefs: jest.fn(async (refs: string[]) => refs.map((ref) => ({ ref, found: true }))),
  };
  const result = { text: X3, model: 'openai:gpt-4.1', inputTokens: 900, outputTokens: 120 };
  const registry = {
    complete: jest.fn(async () => result),
    completeStreaming: jest.fn(async (_request: LlmRequest, onText: (written: string) => void) => {
      for (let i = 13; i < X3.length + 13; i += 13) {
        onText(X3.slice(0, i));
        await new Promise((resolve) => setImmediate(resolve));
      }
      return result;
    }),
  };
  const rag = new RagService(corpus as never, {} as never, registry as never, new GuardrailsService(corpus as never), {} as never, {} as never);
  return { rag, registry };
}

describe('the answer as it is written', () => {
  it('reaches the web chat in checked drafts, all before the finished answer is checked', async () => {
    const { rag, registry } = service();
    const events: (RagStage | RagDraft)[] = [];

    const answer = await rag.answerGeneral(general, undefined, [], (event) => events.push(event));

    expect(registry.completeStreaming).toHaveBeenCalledTimes(1);
    expect(registry.complete).not.toHaveBeenCalled();
    const drafts = events.filter((e): e is RagDraft => typeof e !== 'string').map((e) => e.draft);
    expect(drafts.length).toBeGreaterThan(2);
    for (const draft of drafts) expect(answer.text.startsWith(draft)).toBe(true);
    expect(events.indexOf('verifying')).toBeGreaterThan(events.findIndex((e) => typeof e !== 'string'));
    expect(events.slice(events.indexOf('verifying')).some((e) => typeof e !== 'string')).toBe(false);
    expect(answer.text).toBe(X3);
  });

  it('is asked for in one piece when nobody is watching - WhatsApp, as before', async () => {
    const { rag, registry } = service();

    const answer = await rag.answerGeneral(general, undefined, []);

    expect(registry.complete).toHaveBeenCalledTimes(1);
    expect(registry.completeStreaming).not.toHaveBeenCalled();
    expect(answer.text).toBe(X3);
  });
});
