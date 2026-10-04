import realResponse from './__fixtures__/openai-web-search-order39.json';
import { costLine, parseWebAnswer, UNVERIFIED_NOTE, WebFallbackService, webSearchRequest } from './web-fallback';

/**
 * Unverified information from the web, when every verified source is empty.
 *
 * The fixture is OpenAI's real answer (Responses API, web_search) to the exact
 * request this module sends for "Order 39 Rule 1 CPC" - captured on the
 * production server. CPC Orders are not separate documents on Indian Kanoon,
 * so this question is answered "not available" without it.
 */
const ORDER_39 = ['provision', 'Order 39 Rule 1 CPC', 'Order 39 Rule 1 of the Civil Procedure Code (CPC)'] as const;

/** The real response with its answer text replaced - for what the model may also say. */
function withText(text: string, annotations: unknown[] = realResponse.output[1].content![0].annotations) {
  const message = { ...realResponse.output[1], content: [{ ...realResponse.output[1].content![0], text, annotations }] };
  return { ...realResponse, output: [realResponse.output[0], message] };
}

describe('the request', () => {
  it('is the one the real response answered, with the rules added since', () => {
    const request = webSearchRequest('gpt-4.1-mini', ...ORDER_39);
    // Captured before the rule against offering another case (live test of 4
    // October: an invented SCC citation got "a similar case is Rakesh Kumar
    // Banerjee v. Union of India, 2022 INSC 1056"). Everything before it is
    // what the real response answered.
    const captured = realResponse.instructions.split('\n');
    const current = request.instructions.split('\n');
    expect(current.slice(0, 6)).toEqual(captured.slice(0, 6));
    expect(request.instructions).toContain('Never offer a different case, a "similar" case or a corrected citation in its place.');
    expect(current[current.length - 1]).toMatch(/cannot be found - reply with exactly: NO_RESULT$/);
    expect(request.max_output_tokens).toBe(realResponse.max_output_tokens);
    expect(request.tool_choice).toBe('required');
    expect(request.tools).toEqual([
      { type: 'web_search', search_context_size: 'low', user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' } },
    ]);
  });
});

describe('reading the answer', () => {
  it('takes the text, its source and the note from the real response', () => {
    const found = parseWebAnswer(realResponse);

    expect(found?.text).toMatch(/^Order 39 Rule 1 of the Code of Civil Procedure, 1908, allows courts to grant temporary injunctions/);
    expect(found?.text).toContain('([indiacode.ecourtsindia.com](https://indiacode.ecourtsindia.com/cpc/order/xxxix/rule/1/?utm_source=openai))');
    expect(found?.sources).toEqual([
      {
        title: 'CPC Order 39 Rule 1: Cases in which temporary injunction may be granted | IndiaCode',
        url: 'https://indiacode.ecourtsindia.com/cpc/order/xxxix/rule/1/?utm_source=openai',
      },
    ]);
    expect(found?.note).toBe(UNVERIFIED_NOTE);
  });

  it('shows nothing when the model found nothing', () => {
    expect(parseWebAnswer(withText('NO_RESULT', []))).toBeNull();
  });

  it('shows nothing without a source - an uncited paragraph is the model\'s memory', () => {
    expect(parseWebAnswer(withText(realResponse.output[1].content![0].text, []))).toBeNull();
  });

  it('accepts only web addresses as sources', () => {
    const odd = [{ type: 'url_citation', url: 'javascript:alert(1)', title: 'x', start_index: 0, end_index: 1 }];
    expect(parseWebAnswer(withText('Something.', odd))).toBeNull();
  });

  it('reads nothing from a response that is not one', () => {
    expect(parseWebAnswer({ error: { message: 'model_not_found' } })).toBeNull();
    expect(parseWebAnswer(null)).toBeNull();
  });
});

describe('what it cost, said after the answer', () => {
  it.each([
    [1, true, '1 credit was charged for the unverified information below.'],
    [0, true, 'No credits were charged for this question.'],
    [0, false, 'No credits were charged for this question.'],
  ])('%i credit(s), unverified %s -> %s', (charged, unverified, line) => {
    expect(costLine(charged, unverified)).toBe(line);
  });
});

describe('the search', () => {
  const env = (over: Record<string, unknown> = {}) =>
    ({ WEB_FALLBACK: 'on', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: '', WEB_SEARCH_MODEL: 'gpt-4.1-mini', WEB_FALLBACK_TIMEOUT_MS: 25000, ...over }) as never;
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('asks OpenAI with the key and returns what it found', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(realResponse), { status: 200 }));
    global.fetch = fetchMock as never;

    const found = await new WebFallbackService(env()).find(...ORDER_39);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toEqual(webSearchRequest('gpt-4.1-mini', ...ORDER_39));
    expect(found?.sources).toHaveLength(1);
  });

  it('honours OPENAI_BASE_URL', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(realResponse), { status: 200 }));
    global.fetch = fetchMock as never;

    await new WebFallbackService(env({ OPENAI_BASE_URL: 'https://proxy.example/v1/' })).find(...ORDER_39);
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example/v1/responses');
  });

  it.each([[{ WEB_FALLBACK: 'off' }], [{ OPENAI_API_KEY: '' }]])('does not search when switched off or without a key: %j', async (over) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    expect(await new WebFallbackService(env(over)).find(...ORDER_39)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the reply as it was when OpenAI refuses or does not answer', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('{"error":{"message":"quota"}}', { status: 429 })) as never;
    expect(await new WebFallbackService(env()).find(...ORDER_39)).toBeNull();

    global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')) as never;
    expect(await new WebFallbackService(env()).find(...ORDER_39)).toBeNull();
  });
});
