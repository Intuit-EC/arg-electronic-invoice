import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  FindOptionsWhere,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { CreateJobDto } from './dto/create-job.dto';
import {
  InvoiceJobCallbackStatus,
  InvoiceJobEntity,
  InvoiceJobSourceSystem,
  InvoiceJobStatus,
} from './entities/invoice-job.entity';
import { InvoiceJobResult } from './interfaces/job-result.interface';
import { canonicalJson } from './utils/canonical-payload.util';
import { calculateBackoffSeconds } from './utils/retry-backoff.util';
import {
  assertPublicCallbackDestination,
  parseAndValidateCallbackUrl,
} from './utils/callback-security.util';

export interface CreateJobResult {
  job: InvoiceJobEntity;
  created: boolean;
}

@Injectable()
export class JobsService {
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly retryBaseSeconds: number;
  private readonly retryMaxSeconds: number;
  private readonly callbackRetryMaxSeconds: number;

  constructor(
    @InjectRepository(InvoiceJobEntity)
    private readonly jobsRepository: Repository<InvoiceJobEntity>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.batchSize = this.configService.get<number>('jobs.batchSize') || 10;
    this.leaseSeconds =
      this.configService.get<number>('jobs.leaseSeconds') || 300;
    this.retryBaseSeconds =
      this.configService.get<number>('jobs.retryBaseSeconds') || 30;
    this.retryMaxSeconds =
      this.configService.get<number>('jobs.retryMaxSeconds') || 900;
    this.callbackRetryMaxSeconds =
      this.configService.get<number>('jobs.callbackRetryMaxSeconds') || 3600;
  }

  async createJob(dto: CreateJobDto): Promise<CreateJobResult> {
    this.validateSourceIdentity(dto);
    if (dto.accessKey !== dto.payload.claveAcceso) {
      throw new BadRequestException(
        'accessKey debe coincidir exactamente con payload.claveAcceso',
      );
    }

    const production =
      this.configService.get<string>('app.nodeEnv') === 'production';
    const callbackUrl = parseAndValidateCallbackUrl(
      dto.callbackUrl,
      production,
    );
    await assertPublicCallbackDestination(callbackUrl);

    const normalized = {
      ...dto,
      tenantId:
        dto.sourceSystem === InvoiceJobSourceSystem.ZENNTRAL
          ? dto.tenantId!.trim()
          : null,
      sourceInvoiceId: dto.sourceInvoiceId.trim(),
      callbackUrl: callbackUrl.toString(),
    };

    try {
      const job = this.jobsRepository.create(normalized);
      return { job: await this.jobsRepository.save(job), created: true };
    } catch (error: unknown) {
      if (!this.isUniqueViolation(error)) throw error;
      return this.resolveIdempotencyConflict(normalized);
    }
  }

  async claimSriJobs(): Promise<InvoiceJobEntity[]> {
    await this.failExhaustedSriJobs();
    const queryResult: unknown = await this.dataSource.query(
      `
        WITH candidates AS (
          SELECT "id"
          FROM "invoice_jobs"
          WHERE (
            ("status" = 'PENDING' AND "nextRetryAt" <= NOW())
            OR
            ("status" = 'PROCESSING' AND "lockedUntil" < NOW())
          )
          AND "attempts" < "maxAttempts"
          ORDER BY "nextRetryAt" ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE "invoice_jobs" AS job
        SET "status" = 'PROCESSING',
            "lockedAt" = NOW(),
            "lockedUntil" = NOW() + ($2 * INTERVAL '1 second'),
            "lockToken" = uuid_generate_v4(),
            "attempts" = job."attempts" + 1,
            "updatedAt" = NOW()
        FROM candidates
        WHERE job."id" = candidates."id"
        RETURNING job.*
      `,
      [this.batchSize, this.leaseSeconds],
    );

    const rows = queryResult as InvoiceJobEntity[];
    return rows.map((row) => this.jobsRepository.create(row));
  }

  async renewSriLease(job: InvoiceJobEntity): Promise<boolean> {
    const result = await this.jobsRepository
      .createQueryBuilder()
      .update(InvoiceJobEntity)
      .set({
        lockedUntil: () =>
          `NOW() + (${Math.trunc(this.leaseSeconds)} * INTERVAL '1 second')`,
      })
      .where('id = :id AND status = :status AND "lockToken" = :lockToken', {
        id: job.id,
        status: InvoiceJobStatus.PROCESSING,
        lockToken: job.lockToken,
      })
      .execute();
    return (result.affected || 0) === 1;
  }

  async markSriCompleted(
    job: InvoiceJobEntity,
    invoiceId: string,
    resultPayload: InvoiceJobResult,
  ): Promise<boolean> {
    const result = await this.jobsRepository
      .createQueryBuilder()
      .update(InvoiceJobEntity)
      .set({
        status: InvoiceJobStatus.COMPLETED,
        invoiceId,
        result: resultPayload,
        lastError: null,
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
        callbackStatus: InvoiceJobCallbackStatus.PENDING,
        callbackNextRetryAt: () => 'NOW()',
      })
      .where(
        'id = :id AND status = :status AND "lockToken" = :lockToken AND result IS NULL',
        {
          id: job.id,
          status: InvoiceJobStatus.PROCESSING,
          lockToken: job.lockToken,
        },
      )
      .execute();
    return (result.affected || 0) === 1;
  }

  async retrySriJob(job: InvoiceJobEntity, error: string): Promise<void> {
    const exhausted = job.attempts >= job.maxAttempts;
    const delay = calculateBackoffSeconds(
      job.attempts,
      this.retryBaseSeconds,
      this.retryMaxSeconds,
    );

    await this.jobsRepository
      .createQueryBuilder()
      .update(InvoiceJobEntity)
      .set({
        status: exhausted ? InvoiceJobStatus.FAILED : InvoiceJobStatus.PENDING,
        nextRetryAt: exhausted
          ? () => 'NOW()'
          : () => `NOW() + (${delay} * INTERVAL '1 second')`,
        lastError: this.truncateError(error),
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
      })
      .where('id = :id AND status = :status AND "lockToken" = :lockToken', {
        id: job.id,
        status: InvoiceJobStatus.PROCESSING,
        lockToken: job.lockToken,
      })
      .execute();
  }

  async failSriJob(job: InvoiceJobEntity, error: string): Promise<void> {
    await this.jobsRepository
      .createQueryBuilder()
      .update(InvoiceJobEntity)
      .set({
        status: InvoiceJobStatus.FAILED,
        lastError: this.truncateError(error),
        lockedAt: null,
        lockedUntil: null,
        lockToken: null,
      })
      .where('id = :id AND status = :status AND "lockToken" = :lockToken', {
        id: job.id,
        status: InvoiceJobStatus.PROCESSING,
        lockToken: job.lockToken,
      })
      .execute();
  }

  async claimCallbackJobs(): Promise<InvoiceJobEntity[]> {
    await this.failExhaustedCallbacks();
    const queryResult: unknown = await this.dataSource.query(
      `
        WITH candidates AS (
          SELECT "id"
          FROM "invoice_jobs"
          WHERE "status" = 'COMPLETED'
            AND "result" IS NOT NULL
            AND (
              ("callbackStatus" = 'PENDING' AND "callbackNextRetryAt" <= NOW())
              OR
              ("callbackStatus" = 'PROCESSING' AND "callbackLockedUntil" < NOW())
            )
            AND "callbackAttempts" < "callbackMaxAttempts"
          ORDER BY "callbackNextRetryAt" ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE "invoice_jobs" AS job
        SET "callbackStatus" = 'PROCESSING',
            "callbackLockedAt" = NOW(),
            "callbackLockedUntil" = NOW() + ($2 * INTERVAL '1 second'),
            "callbackLockToken" = uuid_generate_v4(),
            "callbackAttempts" = job."callbackAttempts" + 1,
            "updatedAt" = NOW()
        FROM candidates
        WHERE job."id" = candidates."id"
        RETURNING job.*
      `,
      [this.batchSize, this.leaseSeconds],
    );

    const rows = queryResult as InvoiceJobEntity[];
    return rows.map((row) => this.jobsRepository.create(row));
  }

  async markCallbackDelivered(job: InvoiceJobEntity): Promise<void> {
    await this.jobsRepository
      .createQueryBuilder()
      .update(InvoiceJobEntity)
      .set({
        callbackStatus: InvoiceJobCallbackStatus.DELIVERED,
        callbackLastError: null,
        callbackDeliveredAt: () => 'NOW()',
        callbackLockedAt: null,
        callbackLockedUntil: null,
        callbackLockToken: null,
      })
      .where(
        'id = :id AND "callbackStatus" = :status AND "callbackLockToken" = :lockToken',
        {
          id: job.id,
          status: InvoiceJobCallbackStatus.PROCESSING,
          lockToken: job.callbackLockToken,
        },
      )
      .execute();
  }

  async retryCallback(job: InvoiceJobEntity, error: string): Promise<void> {
    const exhausted = job.callbackAttempts >= job.callbackMaxAttempts;
    const delay = calculateBackoffSeconds(
      job.callbackAttempts,
      this.retryBaseSeconds,
      this.callbackRetryMaxSeconds,
    );

    await this.jobsRepository
      .createQueryBuilder()
      .update(InvoiceJobEntity)
      .set({
        callbackStatus: exhausted
          ? InvoiceJobCallbackStatus.FAILED
          : InvoiceJobCallbackStatus.PENDING,
        callbackNextRetryAt: exhausted
          ? () => 'NOW()'
          : () => `NOW() + (${delay} * INTERVAL '1 second')`,
        callbackLastError: this.truncateError(error),
        callbackLockedAt: null,
        callbackLockedUntil: null,
        callbackLockToken: null,
      })
      .where(
        'id = :id AND "callbackStatus" = :status AND "callbackLockToken" = :lockToken',
        {
          id: job.id,
          status: InvoiceJobCallbackStatus.PROCESSING,
          lockToken: job.callbackLockToken,
        },
      )
      .execute();
  }

  private async resolveIdempotencyConflict(
    dto: Omit<CreateJobDto, 'tenantId'> & { tenantId: string | null },
  ): Promise<CreateJobResult> {
    const tupleWhere: FindOptionsWhere<InvoiceJobEntity> = {
      sourceSystem: dto.sourceSystem,
      sourceInvoiceId: dto.sourceInvoiceId,
      tenantId: dto.tenantId === null ? IsNull() : dto.tenantId,
    };
    const candidates = await this.jobsRepository.find({
      where: [{ accessKey: dto.accessKey }, tupleWhere],
    });
    const expected = this.canonicalIdentity(dto);
    const exact = candidates.find(
      (candidate) => this.canonicalIdentity(candidate) === expected,
    );

    if (exact && candidates.every((candidate) => candidate.id === exact.id)) {
      return { job: exact, created: false };
    }

    throw new ConflictException(
      'La clave de acceso o identidad externa ya existe con datos diferentes',
    );
  }

  private canonicalIdentity(value: {
    sourceSystem: InvoiceJobSourceSystem;
    tenantId?: string | null;
    sourceInvoiceId: string;
    accessKey: string;
    payload: unknown;
  }): string {
    return canonicalJson({
      sourceSystem: value.sourceSystem,
      tenantId: value.tenantId || null,
      sourceInvoiceId: value.sourceInvoiceId,
      accessKey: value.accessKey,
      payload: value.payload,
    });
  }

  private validateSourceIdentity(dto: CreateJobDto): void {
    if (
      dto.sourceSystem === InvoiceJobSourceSystem.ZENNTRAL &&
      !dto.tenantId?.trim()
    ) {
      throw new BadRequestException('tenantId es obligatorio para ZENNTRAL');
    }
    if (
      dto.sourceSystem === InvoiceJobSourceSystem.FACTURACION_BCA &&
      dto.tenantId !== undefined
    ) {
      throw new BadRequestException(
        'tenantId debe omitirse para FACTURACION_BCA',
      );
    }
    if (!dto.sourceInvoiceId.trim()) {
      throw new BadRequestException('sourceInvoiceId no puede estar vacío');
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      String(
        (error as QueryFailedError & { driverError?: { code?: string } })
          .driverError?.code,
      ) === '23505'
    );
  }

  private truncateError(error: string): string {
    return error.slice(0, 10_000);
  }

  private async failExhaustedSriJobs(): Promise<void> {
    await this.dataSource.query(`
      UPDATE "invoice_jobs"
      SET "status" = 'FAILED',
          "lastError" = COALESCE("lastError", 'Se agotó el máximo de intentos'),
          "lockedAt" = NULL,
          "lockedUntil" = NULL,
          "lockToken" = NULL,
          "updatedAt" = NOW()
      WHERE "attempts" >= "maxAttempts"
        AND (
          ("status" = 'PROCESSING' AND "lockedUntil" < NOW())
          OR ("status" = 'PENDING' AND "nextRetryAt" <= NOW())
        )
    `);
  }

  private async failExhaustedCallbacks(): Promise<void> {
    await this.dataSource.query(`
      UPDATE "invoice_jobs"
      SET "callbackStatus" = 'FAILED',
          "callbackLastError" = COALESCE(
            "callbackLastError",
            'Se agotó el máximo de intentos del webhook'
          ),
          "callbackLockedAt" = NULL,
          "callbackLockedUntil" = NULL,
          "callbackLockToken" = NULL,
          "updatedAt" = NOW()
      WHERE "status" = 'COMPLETED'
        AND "callbackAttempts" >= "callbackMaxAttempts"
        AND (
          ("callbackStatus" = 'PROCESSING' AND "callbackLockedUntil" < NOW())
          OR (
            "callbackStatus" = 'PENDING'
            AND "callbackNextRetryAt" <= NOW()
          )
        )
    `);
  }
}
