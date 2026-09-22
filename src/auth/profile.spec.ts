import { UserRow } from '../database/types';
import { IntentService } from '../ai/intent.service';
import { AuthError, AuthService } from './auth.service';

/**
 * Where an advocate practises: asked at signup, and theirs to change.
 *
 * It decides whose judgments come first in a case-law search, so the state is
 * checked against the list on the way in - a typed "Karnatka" would sit on the
 * account looking like an answer while putting no court first.
 */

const USER = {
  id: 'user-1',
  full_name: 'Aryan',
  bar_council_state: null,
  city: null,
} as unknown as UserRow;

function service() {
  const users = {
    updateProfile: jest.fn(async (_id: string, p: { fullName: string | null; city: string | null; state: string | null }) =>
      ({ ...USER, full_name: p.fullName, city: p.city, bar_council_state: p.state }) as UserRow),
  };
  const auth = new AuthService(
    { findByEmail: jest.fn().mockResolvedValue(null) } as never,
    users as never,
    {} as never,
    {} as never,
    { PASSWORD_MIN_LENGTH: 10 } as never,
  );
  return { auth, users };
}

describe('changing your profile', () => {
  it('stores the state as listed, and leaves unsent fields alone', async () => {
    const { auth, users } = service();

    const updated = await auth.updateProfile(USER, { state: 'karnataka', city: '  Bengaluru ' });

    expect(users.updateProfile).toHaveBeenCalledWith('user-1', {
      fullName: 'Aryan',
      state: 'Karnataka',
      city: 'Bengaluru',
    });
    expect(updated.bar_council_state).toBe('Karnataka');
  });

  it('refuses a state that is not on the list', async () => {
    const { auth, users } = service();

    await expect(auth.updateProfile(USER, { state: 'Karnatka' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(users.updateProfile).not.toHaveBeenCalled();
  });

  it('refuses an empty name, but lets the state be cleared', async () => {
    const { auth } = service();

    await expect(auth.updateProfile(USER, { fullName: '   ' })).rejects.toBeInstanceOf(AuthError);
    await expect(auth.updateProfile({ ...USER, bar_council_state: 'Delhi' } as UserRow, { state: '' }))
      .resolves.toMatchObject({ bar_council_state: null });
  });
});

describe('signing up with a state', () => {
  it('refuses one that names no court before anything is created', async () => {
    const { auth } = service();

    await expect(
      auth.signUp({
        email: 'a@b.co', password: 'a-long-enough-password', fullName: 'A', state: 'Atlantis',
        userAgent: null, ip: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('the router, when it calls a case summary a general question', () => {
  it('is overruled: a summary of a named judgment is a judgment search', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'GENERAL_LEGAL', language: 'en', search_query: 'Vishaka summary' }),
      }),
    };
    const intents = new IntentService(registry as never);

    const result = await intents.classify('summary of Vishaka vs State of Rajasthan in 100 words');

    expect(result.intent).toBe('PRECEDENT_SEARCH');
  });

  it('is left alone for a general question that happens to contain "vs"', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'GENERAL_LEGAL', language: 'en', search_query: 'bail' }),
      }),
    };
    const intents = new IntentService(registry as never);

    const result = await intents.classify('difference between bail vs anticipatory bail');

    expect(result.intent).toBe('GENERAL_LEGAL');
  });
});
