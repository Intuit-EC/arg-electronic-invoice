import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvoiceModule } from '../invoice/invoice.module';
import { InvoiceJobEntity } from './entities/invoice-job.entity';
import { SourceApiKeyGuard } from './guards/source-api-key.guard';
import { JobsController } from './jobs.controller';
import { JobsProcessor } from './jobs.processor';
import { JobsService } from './jobs.service';

@Module({
  imports: [TypeOrmModule.forFeature([InvoiceJobEntity]), InvoiceModule],
  controllers: [JobsController],
  providers: [JobsService, JobsProcessor, SourceApiKeyGuard],
  exports: [JobsService],
})
export class JobsModule {}
