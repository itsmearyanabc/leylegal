import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthController } from './auth.controller';

/**
 * Creating an account does not need a one-time code.
 *
 * ## The two halves of what was reported
 *
 * "code is not getting generated for new user" and "it is logging in even
 * after saying that" are the same bug seen from both ends.
 *
 * Signing up started a WhatsApp verification and returned the advocate to a
 * code-entry screen. Delivery needs a Meta-approved template and a working
 * WhatsApp configuration, so when either was missing no code ever arrived -
 * and the session cookie in that same response had already signed them in. The
 * screen said "verify to continue" while the cookie said "you are in".
 */

function controller() {
  const phones = { start: jest.fn().mockResolvedValue({ sent: true }) };
  const auth = { signUp: jest.fn().mockResolvedValue({ user: { id: 'u1' } }) };

  const instance = Object.create(AuthController.prototype) as AuthController;
  Object.assign(instance, {
    phones,
    auth,
    // Both are private plumbing: `run` translates thrown errors and
    // `completeSignIn` sets the session cookie. Neither is what is under test.
    run: (fn: () => unknown) => fn(),
    completeSignIn: jest.fn().mockResolvedValue({ user: { id: 'u1' } }),
  });

  return { instance, phones, auth };
}

const body = { email: 'a@b.co', password: 'a-long-enough-password' };
const request = { headers: {}, ip: '1.2.3.4' };

describe('signing up', () => {
  it('sends no verification code', async () => {
    const { instance, phones } = controller();

    await instance.signUp(body as never, request as never, {} as never);

    expect(phones.start).not.toHaveBeenCalled();
  });

  it('does not hand the client a verification step to render', async () => {
    // The website read `verification` off this response and used it to decide
    // to show the code screen.
    const { instance } = controller();

    const result = await instance.signUp(body as never, request as never, {} as never);

    expect(result).not.toHaveProperty('verification');
  });

  it('still creates the account and signs it in', async () => {
    const { instance, auth } = controller();

    const result = await instance.signUp(body as never, request as never, {} as never);

    expect(auth.signUp).toHaveBeenCalled();
    expect(result).toMatchObject({ user: { id: 'u1' } });
  });
});

describe('the gate that used to stand behind it', () => {
  /*
   * Gone, not merely off. It was switched by PHONE_VERIFICATION_REQUIRED, and
   * .env.example shipped that set to true - so a deployment configured from
   * the template refused every new account on its first request, with a code
   * screen for a code nothing sends.
   */
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('is not in the guard', () => {
    const guard = read('src/auth/user-auth.guard.ts');
    expect(guard).not.toContain('PHONE_UNVERIFIED');
    expect(guard).not.toContain('ForbiddenException');
  });

  it('has no setting left to switch it back on', () => {
    expect(read('src/config/env.ts')).not.toContain('PHONE_VERIFICATION_REQUIRED');
    expect(read('src/settings/settings.catalog.ts')).not.toContain('PHONE_VERIFICATION_REQUIRED');
    expect(read('.env.example')).not.toContain('PHONE_VERIFICATION_REQUIRED');
  });
});

describe('the website', () => {
  const app = readFileSync(join(process.cwd(), 'src/web/assets/app.js.ts'), 'utf8');

  it('takes a new account straight into the app', () => {
    expect(app).not.toContain('renderVerifyPhone');
    expect(app).not.toContain('PHONE_UNVERIFIED');
  });

  it('does not ask for a WhatsApp number to sign up', () => {
    // It was required, validated and then discarded - never stored - so all
    // it did was refuse accounts over a mistyped or already-used number.
    expect(app).not.toContain("payload.phoneNumber");
  });
});
