import realResponse from './__fixtures__/openai-web-search-order39.json';
import {
  admitsNotFound,
  costLine,
  impossibleCitation,
  impossibleCitationHindi,
  namesACase,
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

  it.each([
    // Indian Kanoon's own listing for Nanavati (doc 1596139)
    'AIR 1962 SUPREME COURT 605',
    'air 1962 sc 605 - which case?',
    // the citation in the web's real answer on ADM Jabalpur (live, 2 Oct)
    'AIR 1976 SC 1207',
  ])('reads %s as a real AIR citation, and allows it', (question) => {
    expect(impossibleCitation(question, NOW)).toBeNull();
    expect(impossibleCitation(question.replace(/19\d\d/, '2031'), NOW)).toBe('2031 is still in the future');
  });

  it('does not read the word "air" before a year as an AIR citation', () => {
    expect(impossibleCitation('NGT orders on the clean air 2030 plan for Delhi', NOW)).toBeNull();
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

/**
 * The web's real answers in Ley Legal's own live run of the 2 October audit,
 * word for word from their start - the runner kept 600-700 characters, cut
 * shorter here.
 */
const AUDIT_2_OCT = {
  // NP9, asked: "Summarise the Supreme Court judgment in Ritu Malhotra v. Bar
  // Council of Bihar, (2023) 9 SCC 1088" - an invented case, answered with another
  ritu:
    'I couldn\'t find any information on a Supreme Court case titled "Ritu Malhotra v. Bar Council of Bihar" with the citation "(2023) 9 SCC 1088." ' +
    "It's possible there might be a typographical error in the case name or citation. For instance, there is a case titled \"Ritu Chhabaria v. Union of India\" " +
    'decided on April 26, 2023, with the citation 2023 INSC 436.',
  // P7, ADM Jabalpur - a right answer
  admJabalpur:
    'The Supreme Court of India delivered the judgment in Additional District Magistrate, Jabalpur v. Shivkant Shukla on April 28, 1976. ' +
    'The case citation is AIR 1976 SC 1207. The bench comprised Chief Justice A.N. Ray and Justices M.H. Beg, Y.V. Chandrachud, P.N. Bhagwati, and Hans Raj Khanna. ' +
    'The majority held that during the Emergency, the right to life and personal liberty under Article 21 could be suspended, and habeas corpus petitions could not be entertained.',
  // V2, Arjun Panditrao Khotkar - a right answer
  arjunKhotkar:
    'In Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal, (2020) 7 SCC 1, the Supreme Court held that a certificate under Section 65B(4) of the ' +
    'Indian Evidence Act is mandatory for admitting electronic records as evidence. This requirement is excused only when the party seeking to produce ' +
    'the evidence cannot obtain the certificate despite all reasonable efforts.',
};

describe("the web's real answers in the audit of 2 October", () => {
  it('drops the invented case answered with another (NP9)', () => {
    expect(parseWebAnswer(withText(AUDIT_2_OCT.ritu))).toBeNull();
  });

  it.each([['P7 ADM Jabalpur', AUDIT_2_OCT.admJabalpur], ['V2 Arjun Panditrao Khotkar', AUDIT_2_OCT.arjunKhotkar]])('keeps %s', (_, text) => {
    expect(parseWebAnswer(withText(text))?.text).toBe(text);
  });
});

describe('an answer dropped for admitting it found nothing', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const env = { WEB_FALLBACK: 'on', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: '', WEB_SEARCH_MODEL: 'gpt-4.1-mini', WEB_FALLBACK_TIMEOUT_MS: 25000 } as never;
  const NP9 = 'Summarise the Supreme Court judgment in Ritu Malhotra v. Bar Council of Bihar, (2023) 9 SCC 1088';

  it('is logged with its opening words, so a real answer lost this way can be seen', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(withText(AUDIT_2_OCT.ritu)), { status: 200 })) as never;
    const service = new WebFallbackService(env);
    const info = jest.spyOn((service as unknown as { logger: { info: (...args: unknown[]) => void } }).logger, 'info');

    expect(await service.find('judgment', NP9, 'Ritu Malhotra v. Bar Council of Bihar')).toBeNull();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ found: false, droppedAsNotFound: AUDIT_2_OCT.ritu.slice(0, 300) }),
      'Web search for unverified information',
    );
  });

  it('is not said for NO_RESULT or for an answer that was kept', async () => {
    for (const text of ['NO_RESULT', AUDIT_2_OCT.arjunKhotkar]) {
      global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(withText(text)), { status: 200 })) as never;
      const service = new WebFallbackService(env);
      const info = jest.spyOn((service as unknown as { logger: { info: (...args: unknown[]) => void } }).logger, 'info');

      await service.find('judgment', 'Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal');
      expect(info.mock.calls[0][0]).not.toHaveProperty('droppedAsNotFound');
    }
  });
});

describe('the bench', () => {
  it('is not named: the web named two judges who did not sit in Nanavati (J-CL-07)', () => {
    expect(webSearchRequest('gpt-4.1-mini', 'judgment', 'AIR 1962 SC 605').instructions).toContain(
      '- Do not name the judges or describe the bench.',
    );
  });
});

/**
 * A named judgment answered with another one, and no admission to catch it.
 * Live test of 6 October (second run), P8, word for word.
 */
describe('an answer about another case than the one named', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const env = { WEB_FALLBACK: 'on', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: '', WEB_SEARCH_MODEL: 'gpt-4.1-mini', WEB_FALLBACK_TIMEOUT_MS: 25000 } as never;
  const answering = (text: string) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(withText(text)), { status: 200 })) as never;
    return new WebFallbackService(env);
  };

  const SHATRUGHAN =
    'The Supreme Court of India, in the case of Shatrughan Chauhan & Anr. versus Union of India & Ors., decided on January 21, 2014, held that ' +
    'unexplained, inordinate, and unreasonable delay in the disposal of mercy petitions, along with other supervening circumstances such as mental ' +
    'illness, constitutes grounds for commuting a death sentence to life imprisonment.';
  // 2 October, the same question: the case does not exist - an answer about it.
  const MERCY_DOES_NOT_EXIST =
    'The case "Mercy v. Mankind" does not exist. It was a fictitious citation generated by an AI tool, leading to concerns in the legal community ' +
    'about the use of AI in drafting legal documents.';

  it('is not shown: Mercy v. Mankind answered with Shatrughan Chauhan (P8)', async () => {
    expect(await answering(SHATRUGHAN).find('judgment', 'Mercy v. Mankind judgment ka ratio kya hai?', 'ratio of Mercy v. Mankind')).toBeNull();
  });

  it.each([
    ['Mercy v. Mankind judgment ka ratio kya hai?', MERCY_DOES_NOT_EXIST],
    ['Is ADM Jabalpur v. Shivkant Shukla still good law?', AUDIT_2_OCT.admJabalpur],
    ['What did the Supreme Court hold in (2020) 7 SCC 1?', AUDIT_2_OCT.arjunKhotkar],
  ])('is kept when it is about the case asked for: %s', async (question, text) => {
    expect((await answering(text).find('judgment', question))?.text).toBe(text);
  });
});

/**
 * Fix 1b - from the live check of 7 October 2026.
 *
 * J-CL-03, J-CL-05 and J-CL-07: the web answer described a judgment without
 * naming it (only a source link's title did), and J-CL-03 gave a wrong date.
 * C-06: a made-up CNR was said to be "registered in the eCourts system", for a
 * credit. The texts below follow the graded answers; the exact wording was not
 * kept.
 */
describe('a judgment answer must say which judgment it is about', () => {
  const unnamed = [
    ['J-CL-03', 'The Supreme Court laid down eleven requirements to be followed in all cases of arrest or detention on 18 January 1997.'],
    ['J-CL-05', 'A nine-judge bench held on 24 August 2017 that the right to privacy is a fundamental right under Article 21.'],
    ['J-CL-07', 'On 24 November 1961, in Criminal Appeal No. 195 of 1960, the Court examined grave and sudden provocation.'],
  ];

  it.each(unnamed)('drops %s, which names no case', (_, text) => {
    expect(namesACase(text)).toBe(false);
    expect(parseWebAnswer(withText(text), 'judgment')).toBeNull();
  });

  it.each([
    ['Maneka Gandhi', AUDIT_4_OCT.maneka],
    ['Lalita Kumari', AUDIT_4_OCT.lalitaKumari],
    ['Golaknath', AUDIT_4_OCT.golaknath],
    ['Nanavati', 'K.M. Nanavati v. State of Maharashtra, AIR 1962 SC 605, held that the defence of grave and sudden provocation failed.'],
    ['a "vs" title', 'Arnesh Kumar vs State of Bihar (2014) 8 SCC 273 laid down arrest guidelines.'],
    ['In re', 'In re Arundhati Roy, (2002) 3 SCC 343, concerned contempt of court.'],
  ])('keeps an answer that names the case: %s', (_, text) => {
    expect(namesACase(text)).toBe(true);
    expect(parseWebAnswer(withText(text), 'judgment')?.text).toBe(text);
  });

  it('does not ask a provision answer to name a case', () => {
    expect(parseWebAnswer(realResponse, 'provision')).not.toBeNull();
  });

  it('tells the search to begin with the case name, and to date only from a source', () => {
    const { instructions } = webSearchRequest('gpt-4.1-mini', 'judgment', '(1997) 1 SCC 416');
    expect(instructions).toContain('- For a judgment, begin with its full case name and citation exactly as the pages you cite give them.');
    expect(instructions).toContain('- Give a date only if a page you cite states that date for this judgment.');
  });
});

describe('a CNR eCourts does not know (C-06)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('is not looked for on the web', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const env = { WEB_FALLBACK: 'on', OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: '', WEB_SEARCH_MODEL: 'gpt-4.1-mini', WEB_FALLBACK_TIMEOUT_MS: 25000 } as never;

    expect(await new WebFallbackService(env).find('cnr', 'Status of CNR UPLK010999992023', 'UPLK010999992023')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a citation that cannot exist, asked in Hindi (J-FK-13)', () => {
  const now = new Date('2026-10-07T12:00:00+05:30');

  it('gives the reason in Hindi', () => {
    expect(impossibleCitationHindi("सुप्रीम कोर्ट के 'राजेंद्र कुमार बनाम भारत संघ, (2022) 40 SCC 404' फैसले में क्या कहा गया?", now)).toBe(
      'सुप्रीम कोर्ट केसेज़ (SCC) के किसी भी वर्ष में खंड (volume) 40 नहीं होता',
    );
    expect(impossibleCitationHindi('(2028) 1 SCC 1 का सार', now)).toBe('वर्ष 2028 अभी आया ही नहीं है');
  });

  it('agrees with the English reason on what is impossible', () => {
    for (const text of ['(2022) 40 SCC 404', '(2028) 1 SCC 1', '(2014) 2 SCC 1', '1992 Supp (1) SCC 335']) {
      expect(impossibleCitationHindi(text, now) === null).toBe(impossibleCitation(text, now) === null);
    }
  });
});
