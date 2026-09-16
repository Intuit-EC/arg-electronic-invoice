import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { createHmac } from 'node:crypto';
import { InvoiceService } from '../invoice/invoice.service';
import { ArtifactType } from '../invoice/entities';
import {
  SignatureConfigurationError,
  SriDefinitiveRejectionError,
  SriTemporaryError,
} from '../../shared/errors/sri.errors';
import {
  InvoiceJobEntity,
  InvoiceJobSourceSystem,
} from './entities/invoice-job.entity';
import { JobsService } from './jobs.service';
import { InvoiceJobResult } from './interfaces/job-result.interface';
import {
  assertPublicCallbackDestination,
  createValidatedHttpsAgent,
  parseAndValidateCallbackUrl,
} from './utils/callback-security.util';

@Injectable()
export class JobsProcessor {
  private readonly logger = new Logger(JobsProcessor.name);
  private sriCycleRunning = false;
  private callbackCycleRunning = false;
  private readonly leaseRefreshMs: number;

  constructor(
    private readonly jobsService: JobsService,
    private readonly invoiceService: InvoiceService,
    private readonly configService: ConfigService,
  ) {
    const leaseSeconds =
      this.configService.get<number>('jobs.leaseSeconds') || 300;
    this.leaseRefreshMs = Math.max(
      30_000,
      Math.floor((leaseSeconds * 1000) / 3),
    );
  }

  @Cron('*/10 * * * * *', { name: 'invoice-jobs-sri' })
  async processSriJobs(): Promise<void> {
    if (this.sriCycleRunning) return;
    this.sriCycleRunning = true;

    try {
      const jobs = await this.jobsService.claimSriJobs();
      await Promise.allSettled(jobs.map((job) => this.processSriJob(job)));
    } catch (error: unknown) {
      this.logger.error(
        `No fue posible reclamar jobs SRI: ${this.errorMessage(error)}`,
      );
    } finally {
      this.sriCycleRunning = false;
    }
  }

  @Cron('5/10 * * * * *', { name: 'invoice-jobs-webhook' })
  async processCallbackJobs(): Promise<void> {
    if (this.callbackCycleRunning) return;
    this.callbackCycleRunning = true;

    try {
      const jobs = await this.jobsService.claimCallbackJobs();
      await Promise.allSettled(jobs.map((job) => this.deliverCallback(job)));
    } catch (error: unknown) {
      this.logger.error(
        `No fue posible reclamar callbacks: ${this.errorMessage(error)}`,
      );
    } finally {
      this.callbackCycleRunning = false;
    }
  }

  private async processSriJob(job: InvoiceJobEntity): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.jobsService.renewSriLease(job).then((renewed) => {
        if (!renewed) {
          this.logger.warn(`Se perdió el lease SRI del job ${job.id}`);
        }
      });
    }, this.leaseRefreshMs);

    try {
      const processingResult = await this.invoiceService.processEnqueuedInvoice(
        job.payload,
      );

      if (processingResult.outcome === 'AUTHORIZED') {
        if (!processingResult.authorization) {
          throw new SriTemporaryError(
            'Resultado autorizado incompleto',
            'AUTHORIZED_RESULT_INCOMPLETE',
          );
        }

        const immutableResult = this.buildJobResult(
          job,
          processingResult.invoice.id,
          processingResult.authorization.number,
          processingResult.authorization.authorizedAt,
        );
        const completed = await this.jobsService.markSriCompleted(
          job,
          processingResult.invoice.id,
          immutableResult,
        );
        if (completed) {
          this.logger.log(`Job ${job.id} autorizado y completado`);
        } else {
          this.logger.warn(`Se descartó resultado obsoleto del job ${job.id}`);
        }
        return;
      }

      if (processingResult.outcome === 'REJECTED') {
        await this.jobsService.failSriJob(
          job,
          processingResult.invoice.lastError ||
            'Comprobante rechazado por el SRI',
        );
        return;
      }

      await this.jobsService.retrySriJob(
        job,
        'El comprobante continúa pendiente de autorización en el SRI',
      );
    } catch (error: unknown) {
      const message = this.errorMessage(error);
      if (
        error instanceof SriDefinitiveRejectionError ||
        error instanceof SignatureConfigurationError
      ) {
        await this.jobsService.failSriJob(job, message);
        this.logger.error(`Job ${job.id} falló definitivamente: ${message}`);
      } else {
        await this.jobsService.retrySriJob(job, message);
        const classification =
          error instanceof SriTemporaryError ? 'temporal' : 'no clasificado';
        this.logger.warn(
          `Job ${job.id} reprogramado por error ${classification}: ${message}`,
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async deliverCallback(job: InvoiceJobEntity): Promise<void> {
    try {
      if (!job.result) throw new Error('El job no contiene resultado SRI');

      const production =
        this.configService.get<string>('app.nodeEnv') === 'production';
      const url = parseAndValidateCallbackUrl(job.callbackUrl, production);
      await assertPublicCallbackDestination(url);

      const secret = this.getWebhookSecret(job.sourceSystem);
      if (!secret) {
        throw new Error(
          `No existe secreto webhook configurado para ${job.sourceSystem}`,
        );
      }

      const callbackPayload = {
        event: 'invoice.authorized',
        jobId: job.id,
        sourceSystem: job.sourceSystem,
        tenantId: job.tenantId,
        sourceInvoiceId: job.sourceInvoiceId,
        ...job.result,
      };
      const body = JSON.stringify(callbackPayload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

      const response = await axios.post(url.toString(), body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': job.id,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': `sha256=${signature}`,
        },
        timeout: 5_000,
        maxRedirects: 0,
        validateStatus: () => true,
        httpsAgent: createValidatedHttpsAgent(),
        proxy: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Webhook respondió HTTP ${response.status}`);
      }

      await this.jobsService.markCallbackDelivered(job);
      this.logger.log(`Callback del job ${job.id} entregado`);
    } catch (error: unknown) {
      const message = this.errorMessage(error);
      await this.jobsService.retryCallback(job, message);
      this.logger.warn(`Callback del job ${job.id} reprogramado: ${message}`);
    }
  }

  private buildJobResult(
    job: InvoiceJobEntity,
    invoiceId: string,
    authorizationNumber: string,
    authorizedAt: Date,
  ): InvoiceJobResult {
    const configuredBase =
      this.configService.get<string>('jobs.publicApiUrl') || '';
    const baseUrl = configuredBase.replace(/\/$/, '');
    const artifactBase = `${baseUrl}/invoices/${invoiceId}/artifacts`;

    return {
      accessKey: job.accessKey,
      authorizationNumber,
      authorizedAt: authorizedAt.toISOString(),
      invoiceId,
      xmlUrl: `${artifactBase}/${ArtifactType.XML_AUTHORIZED}`,
      pdfUrl: `${artifactBase}/${ArtifactType.RIDE_PDF}`,
    };
  }

  private getWebhookSecret(sourceSystem: InvoiceJobSourceSystem): string {
    return sourceSystem === InvoiceJobSourceSystem.ZENNTRAL
      ? this.configService.get<string>('jobs.webhookSecrets.zenntral') || ''
      : this.configService.get<string>('jobs.webhookSecrets.facturacionBca') ||
          '';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
