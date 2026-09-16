import { NestFactory } from '@nestjs/core';
import process from 'node:process';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { TransformInterceptor } from './shared/interceptors/transform.interceptor';
import { LoggingInterceptor } from './shared/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Global prefix
  const apiPrefix = configService.get<string>('app.apiPrefix') || 'api/v1';
  app.setGlobalPrefix(apiPrefix);

  // Versioning
  app.enableVersioning({
    type: VersioningType.URI,
  });

  // CORS
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Global filters
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global interceptors
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
  );

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Sistema de Facturación Electrónica SRI')
    .setDescription(
      'API para la generación, firma y envío de comprobantes electrónicos al Servicio de Rentas Internas (SRI) de Ecuador',
    )
    .setVersion('1.0')
    .addTag('Facturas', 'Endpoints para gestión de facturas electrónicas')
    .addTag('Notas de Crédito', 'Endpoints para gestión de notas de crédito')
    .addTag('Notas de Débito', 'Endpoints para gestión de notas de débito')
    .addTag('Retenciones', 'Endpoints para gestión de retenciones')
    .addTag('Guías de Remisión', 'Endpoints para gestión de guías de remisión')
    .addTag('SRI', 'Endpoints para integración con SRI')
    .addTag('Jobs', 'Cola asíncrona de emisión electrónica')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-Api-Key', in: 'header' }, 'x-api-key')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // Start server
  const port = configService.get<number>('app.port') || 3000;

  try {
    await app.listen(port, '0.0.0.0');
    console.log(`
🚀 Application is running on: http://0.0.0.0:${port}/${apiPrefix}
📚 Swagger documentation: http://0.0.0.0:${port}/${apiPrefix}/docs
🏢 Environment: ${configService.get<string>('app.nodeEnv')}
    `);
  } catch (error) {
    console.error('❌ Fatal error during application startup:', error);
    process.exit(1);
  }
}

bootstrap().catch((error) => {
  console.error('❌ Bootstrap failed:', error);
  process.exit(1);
});
