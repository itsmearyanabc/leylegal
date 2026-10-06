import realResponse from './__fixtures__/openai-web-search-order39.json';
import {
  admitsNotFound,
  costLine,
  impossibleCitation,
  parseWebAnswer,
  SCC_MAX_VOLUMES,
  UNVERIFIED_NOTE,
  WebFallbackService,
  webSearchRequest,
} from './web-fallback';

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

/**
 * Fake citations - the live audit of 4 October 2026 (100 never-asked questions).
 *
 * The web search was told never to offer a different case. It did anyway:
 * "(2022) 40 SCC 404" was said to "correspond to" Raj Kumar v. Union of India,
 * and "(2028) 1 SCC 1" got State of M.P. v. Laxmi Narayan (2019) instead. The
 * texts below are the answers it gave, word for word; the checks are in code
 * now, not only in the prompt.
 */
const AUDIT_4_OCT = {
  // J-FK-10, asked: "Give the ratio of Laxmi Narayan v. State, (2028) 1 SCC 1"
  futureYear:
    'I couldn\'t locate a case titled "Laxmi Narayan v. State" with the citation "(2028) 1 SCC 1." The most recent Supreme Court case ' +
    'involving Laxmi Narayan is "The State of Madhya Pradesh v. Laxmi Narayan and Others," decided on March 5, 2019. In this case, the ' +
    'Supreme Court held that High Courts should not mechanically quash FIRs involving non-compoundable offences solely based on a compromise.',
  // J-FK-13, asked in Hindi about "राजेंद्र कुमार बनाम भारत संघ, (2022) 40 SCC 404"
  impossibleVolume:
    "I couldn't find a Supreme Court judgment titled 'Rajendra Kumar v Union of India' reported in (2022) 40 SCC 404. The citation " +
    "'40 SCC 404' corresponds to a judgment delivered on September 21, 2022, in the case of 'Raj Kumar v Union of India'.",
  // J-CL-04, asked: "What is (1978) 1 SCC 248?" - a right answer, kept
  maneka:
    'The case reported as (1978) 1 SCC 248 is *Maneka Gandhi v. Union of India*, decided by the Supreme Court of India on January 25, 1978. ' +
    'The Court held that any law interfering with personal liberty must satisfy a triple test.',
  // J-FK-12, asked about Lalita Kumari with a wrong citation - a right answer, kept
  lalitaKumari:
    'The Supreme Court of India, in Lalita Kumari v. Government of Uttar Pradesh, (2014) 2 SCC 1, held that police officers are mandated ' +
    'to register a First Information Report (FIR) upon receiving information about a cognizable offence.',
  // J-GL-06, asked whether Golaknath is still good law - a right answer, kept
  golaknath:
    'I.C. Golaknath & Ors. v. State of Punjab, decided by an eleven-judge bench of the Supreme Court of India on 27 February 1967, held that ' +
    'Parliament cannot amend Part III of the Constitution. This decision was overruled by the Supreme Court in Kesavananda Bharati v. State of Kerala (1973).',
};

describe('a citation that cannot exist', () => {
  const NOW = new Date('2026-10-05T10:00:00+05:30');

  it.each([
    ['Give the ratio of Laxmi Narayan v. State, (2028) 1 SCC 1', /2028 is still in the future/],
    ["सुप्रीम कोर्ट के 'राजेंद्र कुमार बनाम भारत संघ, (2022) 40 SCC 404' फैसले में क्या कहा गया?", /no year of the Supreme Court Cases \(SCC\) reports has a volume 40/],
    ['Summarise (2023) 99 SCC 1', /volume 99/],
    ['What did 2022 (31) SCC 5 decide?', /volume 31/],
    ['Summarise State v. X, AIR 2031 SC 5', /2031 is still in the future/],
    ['What does 2027 INSC 12 say?', /2027 is still in the future/],
    ['(2030) 2 SCR 10 ka ratio batao', /2030 is still in the future/],
  ])('%s', (question, reason) => {
    expect(impossibleCitation(question, NOW)).toMatch(reason);
  });

  it.each([
    'Which case is (2014) 8 SCC 273?',
    '(2017) 10 SCC 1 summarise',
    'What did the Supreme Court hold in (2020) 7 SCC 1?',
    'AIR 1962 SC 605 — which case and what was held?',
    '1992 Supp (1) SCC 335 — which judgment?',
    'Pooja Ramesh Singh v. J&K Bank, 2026 INSC 668',
    `A real top volume: (2013) ${SCC_MAX_VOLUMES} SCC 1`,
    'Bail pending since (2027) onwards in my matter - judgments?',
    'Judgments on anticipatory bail after chargesheet',
  ])('allows %s', (question) => {
    expect(impossibleCitation(question, NOW)).toBeNull();
  });

  it('dates the year in India: 31 December in UTC is already the next year there', () => {
    const newYearInIndia = new Date('2026-12-31T20:00:00Z');
    expect(impossibleCitation('(2027) 1 SCC 1', newYearInIndia)).toBeNull();
  });

  it('is never searched for on the web', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const env = { WEB_FALLBACK: 'on', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: '', WEB_SEARCH_MODEL: 'gpt-4.1-mini', WEB_FALLBACK_TIMEOUT_MS: 25000 } as never;

    const found = await new WebFallbackService(env).find('judgment', 'Summarise (2023) 99 SCC 1', '(2023) 99 SCC 1');

    expect(found).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('an answer that admits the case was not found', () => {
  it.each([
    ['J-FK-10: a different, real case offered for a 2028 citation', AUDIT_4_OCT.futureYear],
    ['J-FK-13: an impossible citation attached to another case', AUDIT_4_OCT.impossibleVolume],
    ['the case does not exist', 'The case does not exist; it appears to be an AI-generated citation.'],
    ['no such judgment', 'There is no such judgment reported in the SCC.'],
    ['could not be located', 'A judgment with that title could not be located on any court website.'],
    ['no record of the case', 'There is no record of the said case on the Supreme Court website.'],
  ])('is shown as nothing found: %s', (_, text) => {
    expect(admitsNotFound(text)).toBe(true);
    expect(parseWebAnswer(withText(text))).toBeNull();
  });

  it.each([
    ['J-CL-04 Maneka Gandhi', AUDIT_4_OCT.maneka],
    ['J-FK-12 Lalita Kumari, citation corrected', AUDIT_4_OCT.lalitaKumari],
    ['J-GL-06 Golaknath overruled', AUDIT_4_OCT.golaknath],
    ['a holding with "could not find"', 'The High Court held that the trial court could not find any evidence of cruelty under Section 498A.'],
    ['a holding with "does not exist"', 'The Court held that a vested right to appeal does not exist unless a statute grants it.'],
  ])('is kept when it answers: %s', (_, text) => {
    expect(admitsNotFound(text)).toBe(false);
    expect(parseWebAnswer(withText(text))?.text).toBe(text);
  });
});

describe('the bench', () => {
  it('is not named: the web named two judges who did not sit in Nanavati (J-CL-07)', () => {
    expect(webSearchRequest('gpt-4.1-mini', 'judgment', 'AIR 1962 SC 605').instructions).toContain(
      '- Do not name the judges or describe the bench.',
    );
  });
});
