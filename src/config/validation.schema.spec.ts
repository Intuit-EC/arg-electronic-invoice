import { validationSchema } from './validation.schema';

describe('validationSchema', () => {
  it('allows empty worker credentials outside production', () => {
    const result = validationSchema.validate(
      { NODE_ENV: 'development' },
      { abortEarly: false, allowUnknown: true },
    );
    const value = result.value as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(value.SRI_USE_MOCK).toBe(false);
    expect(value.ZENNTRAL_API_KEY).toBe('');
    expect(value.FACTURACION_BCA_API_KEY).toBe('');
  });

  it('rejects empty production worker settings and explicit SRI mock', () => {
    const { error } = validationSchema.validate(
      {
        NODE_ENV: 'production',
        SRI_USE_MOCK: true,
        PUBLIC_API_URL: '',
        ZENNTRAL_API_KEY: '',
        FACTURACION_BCA_API_KEY: '',
        ZENNTRAL_WEBHOOK_SECRET: '',
        FACTURACION_BCA_WEBHOOK_SECRET: '',
      },
      { abortEarly: false, allowUnknown: true },
    );

    expect(error).toBeDefined();
    expect(error?.details.map((detail) => detail.path.join('.'))).toEqual(
      expect.arrayContaining([
        'SRI_USE_MOCK',
        'PUBLIC_API_URL',
        'ZENNTRAL_API_KEY',
        'FACTURACION_BCA_API_KEY',
        'ZENNTRAL_WEBHOOK_SECRET',
        'FACTURACION_BCA_WEBHOOK_SECRET',
      ]),
    );
  });

  it('rejects duplicated production source credentials', () => {
    const sharedApiKey = 'a'.repeat(32);
    const sharedWebhookSecret = 'b'.repeat(32);

    const { error } = validationSchema.validate(
      {
        NODE_ENV: 'production',
        SRI_USE_MOCK: false,
        PUBLIC_API_URL: 'https://api.example.com',
        ZENNTRAL_API_KEY: sharedApiKey,
        FACTURACION_BCA_API_KEY: sharedApiKey,
        ZENNTRAL_WEBHOOK_SECRET: sharedWebhookSecret,
        FACTURACION_BCA_WEBHOOK_SECRET: sharedWebhookSecret,
      },
      { abortEarly: false, allowUnknown: true },
    );

    expect(error).toBeDefined();
    expect(error?.message).toContain(
      'FACTURACION_BCA_API_KEY debe ser diferente de ZENNTRAL_API_KEY',
    );
    expect(error?.message).toContain(
      'FACTURACION_BCA_WEBHOOK_SECRET debe ser diferente de ZENNTRAL_WEBHOOK_SECRET',
    );
  });

  it('accepts complete production worker settings', () => {
    const { error } = validationSchema.validate(
      {
        NODE_ENV: 'production',
        SRI_USE_MOCK: false,
        PUBLIC_API_URL: 'https://api.example.com',
        ZENNTRAL_API_KEY: 'z'.repeat(32),
        FACTURACION_BCA_API_KEY: 'b'.repeat(32),
        ZENNTRAL_WEBHOOK_SECRET: 's'.repeat(32),
        FACTURACION_BCA_WEBHOOK_SECRET: 't'.repeat(32),
      },
      { abortEarly: false, allowUnknown: true },
    );

    expect(error).toBeUndefined();
  });
});
