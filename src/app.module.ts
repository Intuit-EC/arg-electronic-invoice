import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';

// Modules
import { InvoiceModule } from './modules/invoice/invoice.module';
import { IssuerModule } from './modules/issuer/issuer.module';
import { CreditNoteModule } from './modules/credit-note/credit-note.module';
import { DebitNoteModule } from './modules/debit-note/debit-note.module';
import { RetentionModule } from './modules/retention/retention.module';
import { RemissionGuideModule } from './modules/remission-guide/remission-guide.module';
import { SriModule } from './modules/sri/sri.module';
import { XmlBuilderModule } from './modules/xml-builder/xml-builder.module';
import { SignatureModule } from './modules/signature/signature.module';
import { StorageModule } from './modules/storage/storage.module';
import { PdfGeneratorModule } from './modules/pdf-generator/pdf-generator.module';
import { JobsModule } from './modules/jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('database.host'),
        port: configService.get('database.port'),
        username: configService.get('database.username'),
        password: configService.get('database.password'),
        database: configService.get('database.database'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: configService.get('database.synchronize'),
        logging: configService.get('app.nodeEnv') === 'development',
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    InvoiceModule,
    IssuerModule,
    CreditNoteModule,
    DebitNoteModule,
    RetentionModule,
    RemissionGuideModule,
    SriModule,
    XmlBuilderModule,
    SignatureModule,
    StorageModule,
    PdfGeneratorModule,
    JobsModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
