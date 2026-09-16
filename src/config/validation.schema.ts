import Joi from 'joi';

const optionalString = Joi.string().allow('').default('');

const requiredInProductionUri = Joi.alternatives().conditional('NODE_ENV', {
  is: 'production',
  then: Joi.string().uri().required(),
  otherwise: optionalString,
});

const requiredInProductionSecret = Joi.alternatives().conditional('NODE_ENV', {
  is: 'production',
  then: Joi.string().min(32).required(),
  otherwise: optionalString,
});

export const validationSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),

  // Database
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().default('postgres'),
  DB_PASSWORD: Joi.string().default('postgres'),
  DB_DATABASE: Joi.string().default('electronic_invoice'),
  DB_SYNC: Joi.boolean().default(false),

  // SRI
  SRI_WS_RECEPTION_URL: Joi.string()
    .uri()
    .default(
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    ),
  SRI_WS_AUTHORIZATION_URL: Joi.string()
    .uri()
    .default(
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
    ),
  SRI_USE_MOCK: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().valid(false).required(),
    otherwise: Joi.boolean().default(false),
  }),

  // Digital Signature
  SIGNATURE_PATH: Joi.string().default('./certificates/signature.p12'),
  SIGNATURE_PASSWORD: Joi.string().allow('').default(''),

  // Company
  COMPANY_RUC: Joi.string().length(13).default('1234567890001'),
  COMPANY_NAME: Joi.string().default('Empresa Demo'),
  COMPANY_TRADENAME: Joi.string().default('Empresa Demo'),
  COMPANY_ADDRESS: Joi.string().default('Dirección Demo'),
  COMPANY_EMAIL: Joi.string().email().default('demo@example.com'),
  COMPANY_PHONE: Joi.string().default('0999999999'),

  // Email
  MAIL_HOST: Joi.string().default('smtp.gmail.com'),
  MAIL_PORT: Joi.number().default(587),
  MAIL_SECURE: Joi.boolean().default(false),
  MAIL_USER: Joi.string().allow('').optional(),
  MAIL_PASSWORD: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().email().default('demo@example.com'),

  // JWT
  JWT_SECRET: Joi.string().default('default_secret_key_change_me'),
  JWT_EXPIRATION: Joi.string().default('1d'),

  // Storage
  STORAGE_PATH: Joi.string().default('./storage'),
  XML_PATH: Joi.string().default('./storage/xml'),
  PDF_PATH: Joi.string().default('./storage/pdf'),
  MAX_FILE_SIZE: Joi.number().default(5242880),
  ALLOWED_FILE_TYPES: Joi.string().default('.p12,.pfx'),

  // Logging
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'debug')
    .default('info'),

  // Background jobs
  JOBS_BATCH_SIZE: Joi.number().integer().min(1).max(100).default(10),
  JOBS_LEASE_SECONDS: Joi.number().integer().min(120).default(300),
  JOBS_RETRY_BASE_SECONDS: Joi.number().integer().min(1).default(30),
  JOBS_RETRY_MAX_SECONDS: Joi.number().integer().min(30).default(900),
  CALLBACK_RETRY_MAX_SECONDS: Joi.number().integer().min(30).default(3600),
  PUBLIC_API_URL: requiredInProductionUri,
  ZENNTRAL_API_KEY: requiredInProductionSecret,
  FACTURACION_BCA_API_KEY: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .min(32)
      .invalid(Joi.ref('ZENNTRAL_API_KEY'))
      .required()
      .messages({
        'any.invalid':
          'FACTURACION_BCA_API_KEY debe ser diferente de ZENNTRAL_API_KEY',
      }),
    otherwise: optionalString,
  }),
  ZENNTRAL_WEBHOOK_SECRET: requiredInProductionSecret,
  FACTURACION_BCA_WEBHOOK_SECRET: Joi.alternatives().conditional('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .min(32)
      .invalid(Joi.ref('ZENNTRAL_WEBHOOK_SECRET'))
      .required()
      .messages({
        'any.invalid':
          'FACTURACION_BCA_WEBHOOK_SECRET debe ser diferente de ZENNTRAL_WEBHOOK_SECRET',
      }),
    otherwise: optionalString,
  }),
});
