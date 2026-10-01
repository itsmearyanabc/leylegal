import searchResponse from './__fixtures__/ecourtsindia-search-idfc.json';
import { EcourtsMisconfiguredError, EcourtsService } from './ecourts.service';

/**
 * The party search as sent to eCourtsIndia, answered with its real response
 * to the client's case (__fixtures__/ecourtsindia-search-idfc.json).
 */
const EMPTY = { data: { ...searchResponse.data, results: [], totalHits: 0 } };

function service(mode = 'http') {
  const settings = {
    get: (key: string) =>
      ({ ECOURTS_MODE: mode, ECOURTS_BASE_URL: 'https://webapi.ecourtsindia.com/api/partner/', ECOURTS_API_KEY: 'eci_live_test' })[key] ?? '',
  };
  const env = { ECOURTS_MODE: mode, ECOURTS_TIMEOUT_MS: 15000, ECOURTS_BREAKER_THRESHOLD: 5, ECOURTS_BREAKER_RESET_MS: 60000, NODE_ENV: 'test' };
  return new EcourtsService(env as never, settings as never);
}

function answering(...bodies: unknown[]) {
  const fetchMock = jest.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  global.fetch = fetchMock as never;
  return fetchMock;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe('searching eCourts by parties', () => {
  it('asks for both parties, every word matching, with the key', async () => {
    const fetchMock = answering(searchResponse);

    const result = await service().searchByParties('idfc First bank', 'aditya bhatia 6897');

    const [url, init] = fetchMock.mock.calls[0];
    const sent = new URL(url);
    expect(`${sent.origin}${sent.pathname}`).toBe('https://webapi.ecourtsindia.com/api/partner/search');
    expect(sent.searchParams.getAll('petitioners')).toEqual(['idfc First bank']);
    expect(sent.searchParams.getAll('respondents')).toEqual(['aditya bhatia 6897']);
    expect(sent.searchParams.get('nameMatchMode')).toBe('all');
    expect(sent.searchParams.get('pageSize')).toBe('5');
    expect(init.headers.authorization).toBe('Bearer eci_live_test');
    expect(result.cases.map((c) => c.cnr)).toEqual(['DLCT010012342024']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows one typo a word only after an exact search found nothing', async () => {
    const fetchMock = answering(EMPTY, searchResponse);

    const result = await service().searchByParties('idfc First bank', 'aditya bhatiya 6897');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('nameMatchMode')).toBe('fuzzy');
    expect(result.cases).toHaveLength(1);
  });

  it('does not pay twice for the same parties', async () => {
    const fetchMock = answering(searchResponse);
    const s = service();

    await s.searchByParties('idfc First bank', 'aditya bhatia 6897');
    await s.searchByParties('IDFC First Bank', 'Aditya  Bhatia 6897');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('finds nothing in mock mode rather than inventing who is party to what', async () => {
    const fetchMock = answering();
    expect(await service('mock').searchByParties('idfc First bank', 'aditya bhatia 6897')).toEqual({ totalHits: 0, cases: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a rejected key as a configuration problem', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })) as never;
    await expect(service().searchByParties('idfc First bank', null)).rejects.toBeInstanceOf(EcourtsMisconfiguredError);
  });
});

describe('the cases for a question', () => {
  it('reads the parties from the question and returns what eCourts has', async () => {
    answering(searchResponse);
    const found = await service().casesForQuestion('idfc First bank vs aditya bhatia 6897');
    expect(found?.query).toBe('idfc First bank vs aditya bhatia 6897');
    expect(found?.result.cases[0].cnr).toBe('DLCT010012342024');
  });

  it('costs nothing for a question that names no case', async () => {
    const fetchMock = answering();
    expect(await service().casesForQuestion('judgments on default bail')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the answer to the judgments when eCourts fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')) as never;
    expect(await service().casesForQuestion('idfc First bank vs aditya bhatia 6897')).toBeNull();
  });
});
