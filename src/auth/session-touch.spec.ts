import { AuthService, SESSION_TOUCH_INTERVAL_MS } from './auth.service';

/**
 * Every signed-in request looks its session up. Recording "last used" is a
 * write the repository only makes when the timestamp is over an hour old, so
 * asking for it on every request was a database round trip that changed
 * nothing nearly every time - one per question, on the path that runs out of
 * connections first under load.
 */
function service(lastUsedAt: Date) {
  const repo = {
    findSessionUser: jest.fn().mockResolvedValue({
      session: { id: 'session-1', last_used_at: lastUsedAt },
      user: { id: 'user-1' },
    }),
    touchSession: jest.fn().mockResolvedValue(undefined),
  };
  const auth = new AuthService(repo as never, {} as never, {} as never, {} as never, {} as never);
  return { auth, repo };
}

describe('recording when a session was last used', () => {
  it('skips the write when the session was used within the hour', async () => {
    const { auth, repo } = service(new Date(Date.now() - 5 * 60 * 1000));

    await expect(auth.resolveSession('token')).resolves.toMatchObject({ user: { id: 'user-1' } });
    expect(repo.touchSession).not.toHaveBeenCalled();
  });

  it('writes it once the hour has passed', async () => {
    const { auth, repo } = service(new Date(Date.now() - SESSION_TOUCH_INTERVAL_MS - 60 * 1000));

    await auth.resolveSession('token');
    expect(repo.touchSession).toHaveBeenCalledWith('session-1');
  });

  it('never fails the request over the bookkeeping write', async () => {
    const { auth, repo } = service(new Date(0));
    repo.touchSession.mockRejectedValue(new Error('pool exhausted'));

    await expect(auth.resolveSession('token')).resolves.not.toBeNull();
  });
});
