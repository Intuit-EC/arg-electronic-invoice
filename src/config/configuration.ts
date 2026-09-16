export default () => ({
  app: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    apiPrefix: process.env.API_PREFIX || 'api/v1',
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    synchronize: process.env.DB_SYNC === 'true',
  },
  sri: {
    receptionUrl: process.env.SRI_WS_RECEPTION_URL,
    authorizationUrl: process.env.SRI_WS_AUTHORIZATION_URL,
    useMock: process.env.SRI_USE_MOCK === 'true',
  },
  signature: {
    path: process.env.SIGNATURE_PATH,
    password: process.env.SIGNATURE_PASSWORD,
  },
  company: {
    ruc: process.env.COMPANY_RUC,
    name: process.env.COMPANY_NAME,
    tradeName: process.env.COMPANY_TRADENAME,
    address: process.env.COMPANY_ADDRESS,
    email: process.env.COMPANY_EMAIL,
    phone: process.env.COMPANY_PHONE,
  },
  mail: {
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.MAIL_PORT || '587', 10),
    secure: process.env.MAIL_SECURE === 'true',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASSWORD,
    },
    from: process.env.MAIL_FROM,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRATION || '1d',
  },
  storage: {
    // Configuración legada (mantener por compatibilidad)
    path: process.env.STORAGE_PATH || './storage',
    xmlPath: process.env.XML_PATH || './storage/xml',
    pdfPath: process.env.PDF_PATH || './storage/pdf',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '5242880', 10),
    allowedFileTypes: process.env.ALLOWED_FILE_TYPES?.split(',') || [
      '.p12',
      '.pfx',
    ],

    // Nueva configuración de storage multi-provider
    provider: process.env.STORAGE_PROVIDER || 'local', // 'local' | 'gcs' | 's3' | 'postgresql'
    localPath: process.env.STORAGE_LOCAL_PATH || './storage',

    // Google Cloud Storage
    gcsBucket: process.env.GCS_BUCKET,
    gcsKeyFilePath: process.env.GCS_KEY_FILE_PATH,

    // AWS S3 (futuro)
    s3Bucket: process.env.S3_BUCKET,
    s3Region: process.env.S3_REGION,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  jobs: {
    batchSize: parseInt(process.env.JOBS_BATCH_SIZE || '10', 10),
    leaseSeconds: parseInt(process.env.JOBS_LEASE_SECONDS || '300', 10),
    retryBaseSeconds: parseInt(process.env.JOBS_RETRY_BASE_SECONDS || '30', 10),
    retryMaxSeconds: parseInt(process.env.JOBS_RETRY_MAX_SECONDS || '900', 10),
    callbackRetryMaxSeconds: parseInt(
      process.env.CALLBACK_RETRY_MAX_SECONDS || '3600',
      10,
    ),
    publicApiUrl: process.env.PUBLIC_API_URL || '',
    apiKeys: {
      zenntral: process.env.ZENNTRAL_API_KEY || '',
      facturacionBca: process.env.FACTURACION_BCA_API_KEY || '',
    },
    webhookSecrets: {
      zenntral: process.env.ZENNTRAL_WEBHOOK_SECRET || '',
      facturacionBca: process.env.FACTURACION_BCA_WEBHOOK_SECRET || '',
    },
  },
});
