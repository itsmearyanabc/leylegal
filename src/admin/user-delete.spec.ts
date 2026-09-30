import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminController, maskEmail } from './admin.controller';

/**
 * Deleting an account from the admin panel.
 *
 * The delete itself is one transaction in AdminRepository; what is pinned here
 * are the guards in front of it, because each of them is the only thing
 * standing between a stray request and an advocate's research history.
 */
describe('admin account deletion', () => {
  const ID = '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
  const removed = {
    chat_threads: 2, chat_messages: 9, whatsapp_messages: 14, search_history: 5,
    credit_ledger: 7, credit_orders: 0, web_sessions: 1, user_identities: 0, auth_tokens: 0, queued_jobs: 0,
  };

  function build(role: string | null) {
    const adminRepo = {
      deleteUserCompletely: jest.fn().mockResolvedValue({ phone: '919812345678', email: 'asha@example.com', removed }),
      auditUserDeletion: jest.fn().mockResolvedValue(undefined),
    };
    const db = { sql: jest.fn().mockResolvedValue(role ? [{ role }] : []) };
    const controller = new AdminController(
      {} as never, {} as never, {} as never, adminRepo as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      db as never,
      {} as never,
    );
    return { controller, adminRepo };
  }

  const req = { admin: { email: 'ops@leylegal.in', role: 'SUPER_ADMIN', via: 'session' } } as never;

  it('refuses without a confirmation that repeats the id', async () => {
    const { controller, adminRepo } = build('GUEST_LAWYER');
    await expect(controller.deleteUser(ID, undefined, req)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.deleteUser(ID, 'yes', req)).rejects.toBeInstanceOf(BadRequestException);
    expect(adminRepo.deleteUserCompletely).not.toHaveBeenCalled();
  });

  it('refuses a malformed id before touching the database', async () => {
    const { controller, adminRepo } = build('GUEST_LAWYER');
    await expect(controller.deleteUser('not-a-uuid', 'not-a-uuid', req)).rejects.toBeInstanceOf(BadRequestException);
    expect(adminRepo.deleteUserCompletely).not.toHaveBeenCalled();
  });

  it('refuses to delete a super admin', async () => {
    const { controller, adminRepo } = build('SUPER_ADMIN');
    await expect(controller.deleteUser(ID, ID, req)).rejects.toBeInstanceOf(BadRequestException);
    expect(adminRepo.deleteUserCompletely).not.toHaveBeenCalled();
  });

  it('answers 404 for an account that does not exist', async () => {
    const { controller } = build(null);
    await expect(controller.deleteUser(ID, ID, req)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes, reports what went, and audits without keeping the email', async () => {
    const { controller, adminRepo } = build('VERIFIED_ADVOCATE');
    const result = await controller.deleteUser(ID, ID, req);

    expect(result).toEqual({ deleted: true, removed });
    expect(adminRepo.deleteUserCompletely).toHaveBeenCalledWith(ID);

    const [auditedId, summary, by] = adminRepo.auditUserDeletion.mock.calls[0];
    expect(auditedId).toBe(ID);
    expect(by).toBe('ops@leylegal.in');
    expect(summary).toContain('a•••@example.com');
    expect(summary).not.toContain('asha@example.com');
    expect(summary).toContain('9 chat messages');
  });

  it('masks an email down to its first letter and domain', () => {
    expect(maskEmail('aryan@gmail.com')).toBe('a•••@gmail.com');
    expect(maskEmail('not-an-email')).toBe('•••');
  });
});
