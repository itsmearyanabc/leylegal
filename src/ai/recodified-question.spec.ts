import { IntentService } from './intent.service';
import { recodifiedReference } from './legal-patterns';

/**
 * "CrPC 125 maintenance - which section in BNSS?" was classified by the router
 * as BNSS 125. That is a real section - security for keeping the peace on
 * conviction - so once the full BNSS is loaded the answer would be confident
 * and about the wrong provision. The section to look up is the one the number
 * belongs to; the official correspondence supplies the other side.
 */
describe('a question naming both codes of a recodification pair', () => {
  it.each([
    ['CrPC 125 maintenance - which section in BNSS?', 'CRPC', '125'],
    ['which BNSS section replaced section 125 of the CrPC', 'CRPC', '125'],
    ['125 CrPC ka BNSS mein kya section hai', 'CRPC', '125'],
    ['IPC 420 is now which section of BNS', 'IPC', '420'],
    ['IPC 302 BNS mein kya hai', 'IPC', '302'],
    ['what was BNSS 144 in the CrPC', 'BNSS', '144'],
    ['section 498A IPC equivalent in Bharatiya Nyaya Sanhita', 'IPC', '498A'],
    ['Evidence Act 65B corresponding section in BSA', 'IEA', '65B'],
    ['CrPC 156(3) under BNSS', 'CRPC', '156(3)'],
  ])('%p -> %s %s', (text, act, section) => {
    expect(recodifiedReference(text)).toEqual({ act, section });
  });

  it.each([
    ['IPC 302 vs BNS 103', 'both sides carry a number'],
    ['what is BNSS 144', 'only one code named'],
    ['punishment under IPC and BNS for murder', 'no number at all'],
    ['CrPC 125 and IPC 420', 'not a pair'],
  ])('decides nothing for %p (%s)', (text) => {
    expect(recodifiedReference(text)).toBeNull();
  });

  function serviceAnswering(classification: Record<string, unknown>) {
    const registry = { complete: jest.fn().mockResolvedValue({ text: JSON.stringify(classification) }) };
    return new IntentService(registry as never);
  }

  it('overrides the router when it reads the old section number as a new-code one', async () => {
    const intent = await serviceAnswering({
      intent: 'SECTION_LOOKUP', language: 'en', act_code: 'BNSS', section_number: '125', search_query: 'maintenance',
    }).classify('CrPC 125 maintenance - which section in BNSS?');

    expect(intent).toMatchObject({ intent: 'SECTION_LOOKUP', actCode: 'CRPC', sectionNumber: '125' });
  });

  it('keeps the act the advocate wrote when the router reads BNSS as BNS', async () => {
    const intent = await serviceAnswering({
      intent: 'SECTION_LOOKUP', language: 'en', act_code: 'BNS', section_number: '520', search_query: 'section 520',
    }).classify('Section 520 BNSS.');

    expect(intent).toMatchObject({ actCode: 'BNSS', sectionNumber: '520' });
  });

  it('leaves the router alone when the message names two acts', async () => {
    const intent = await serviceAnswering({
      intent: 'SECTION_LOOKUP', language: 'en', act_code: 'BNS', section_number: '103', search_query: 'murder',
    }).classify('IPC 302 vs BNS 103');

    expect(intent).toMatchObject({ actCode: 'BNS', sectionNumber: '103' });
  });

  it('makes a catch-all classification a section lookup, but leaves a judgment search alone', async () => {
    const general = await serviceAnswering({ intent: 'GENERAL_LEGAL', language: 'en', act_code: null, section_number: null, search_query: 'x' })
      .classify('IPC 420 is now which section of BNS');
    expect(general).toMatchObject({ intent: 'SECTION_LOOKUP', actCode: 'IPC', sectionNumber: '420' });

    const research = await serviceAnswering({ intent: 'PRECEDENT_SEARCH', language: 'en', act_code: 'BNSS', section_number: '125', search_query: 'x' })
      .classify('judgments on CrPC 125 under the BNSS');
    expect(research).toMatchObject({ intent: 'PRECEDENT_SEARCH', actCode: 'CRPC', sectionNumber: '125' });
  });
});
