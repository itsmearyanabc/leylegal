import { WhatsAppApiService } from './whatsapp-api.service';

/**
 * A sign-up or password-reset code, sent as an authentication template.
 *
 * Asserted against the payload in Meta's "Copy code authentication templates"
 * (updated 24 June 2026): the copy-code button is sub_type "url" with the code
 * as a text parameter. It was sent as a marketing template's "copy_code" /
 * coupon_code button, which Meta refuses for an authentication template - so
 * no code could have been delivered once WhatsApp was switched on.
 */
describe('sending a one-time code', () => {
  function service(over: Record<string, string> = {}) {
    const values: Record<string, string> = { WHATSAPP_OTP_TEMPLATE_NAME: 'otp_verify', WHATSAPP_OTP_TEMPLATE_LANG: 'en', ...over };
    const s = new WhatsAppApiService({ get: (key: string) => values[key] ?? '' } as never, {} as never);
    const send = jest.spyOn(s, 'send').mockResolvedValue({ ok: true } as never);
    return { s, send };
  }

  it('is the authentication template Meta documents, code in body and button', async () => {
    const { s, send } = service();

    await s.sendAuthCode('919876543210', '482913');

    expect(send).toHaveBeenCalledWith({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'otp_verify',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
        ],
      },
    });
  });

  it('uses the template name and language configured', async () => {
    const { s, send } = service({ WHATSAPP_OTP_TEMPLATE_NAME: 'leylegal_code', WHATSAPP_OTP_TEMPLATE_LANG: 'en_US' });

    await s.sendAuthCode('919876543210', '482913');

    expect(send.mock.calls[0][0]).toMatchObject({ template: { name: 'leylegal_code', language: { code: 'en_US' } } });
  });
});
