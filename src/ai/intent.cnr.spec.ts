import { IntentService } from './intent.service';

/**
 * The router's cnr_number is kept only when it is a CNR.
 *
 * "Check the status of CNR 831/2024" came back with cnr_number "831/2024" - a
 * filing number - and was charged, sent to eCourts and answered "No case found
 * for CNR 831/2024".
 */
function classifierSaying(json: Record<string, unknown>) {
  const registry = {
    complete: jest.fn().mockResolvedValue({ text: JSON.stringify(json), model: 'router', inputTokens: 0, outputTokens: 0 }),
  };
  return new IntentService(registry as never);
}

describe('a CNR from the router', () => {
  it('is dropped when it is a filing number', async () => {
    const intent = await classifierSaying({ intent: 'CASE_STATUS', cnr_number: '831/2024', confidence: 0.9 }).classify(
      'Check the status of CNR 831/2024',
    );

    expect(intent.intent).toBe('CASE_STATUS');
    expect(intent.cnrNumber).toBeNull();
  });

  it('is kept, normalised, when it is one', async () => {
    const intent = await classifierSaying({ intent: 'CASE_STATUS', cnr_number: 'dlct01-001234-2024', confidence: 0.9 }).classify(
      'what is happening in my case',
    );

    expect(intent.cnrNumber).toBe('DLCT010012342024');
  });

  it('is dropped when it has a year in the future', async () => {
    const intent = await classifierSaying({ intent: 'CASE_STATUS', cnr_number: 'DLCT010012342099', confidence: 0.9 }).classify(
      'status please',
    );

    expect(intent.cnrNumber).toBeNull();
  });
});
