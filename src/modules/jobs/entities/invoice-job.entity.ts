import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { IssueInvoiceDto } from '../../invoice/dto';
import { Invoice } from '../../invoice/entities';
import { InvoiceJobResult } from '../interfaces/job-result.interface';

export enum InvoiceJobSourceSystem {
  ZENNTRAL = 'ZENNTRAL',
  FACTURACION_BCA = 'FACTURACION_BCA',
}

export enum InvoiceJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum InvoiceJobCallbackStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

@Entity('invoice_jobs')
@Check(
  'CHK_invoice_jobs_zenntral_tenant',
  `"sourceSystem" <> 'ZENNTRAL' OR "tenantId" IS NOT NULL`,
)
@Check('CHK_invoice_jobs_access_key', `"accessKey" ~ '^[0-9]{49}$'`)
@Check('CHK_invoice_jobs_attempts', `"attempts" >= 0 AND "maxAttempts" > 0`)
@Check(
  'CHK_invoice_jobs_callback_attempts',
  `"callbackAttempts" >= 0 AND "callbackMaxAttempts" > 0`,
)
@Index('UQ_invoice_jobs_access_key', ['accessKey'], { unique: true })
@Index(
  'UQ_invoice_jobs_source_tenant_invoice',
  ['sourceSystem', 'tenantId', 'sourceInvoiceId'],
  { unique: true, where: `"tenantId" IS NOT NULL` },
)
@Index(
  'UQ_invoice_jobs_source_invoice_without_tenant',
  ['sourceSystem', 'sourceInvoiceId'],
  { unique: true, where: `"tenantId" IS NULL` },
)
@Index('IDX_invoice_jobs_sri_claim', ['status', 'nextRetryAt', 'createdAt'])
@Index('IDX_invoice_jobs_callback_claim', [
  'status',
  'callbackStatus',
  'callbackNextRetryAt',
  'createdAt',
])
export class InvoiceJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: InvoiceJobSourceSystem,
    enumName: 'invoice_jobs_source_system_enum',
  })
  sourceSystem: InvoiceJobSourceSystem;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 150 })
  sourceInvoiceId: string;

  @Column({ type: 'varchar', length: 49 })
  accessKey: string;

  @Column({ type: 'jsonb' })
  payload: IssueInvoiceDto;

  @Column({ type: 'varchar', length: 2048 })
  callbackUrl: string;

  @Column({ type: 'uuid', nullable: true })
  invoiceId: string | null;

  @ManyToOne(() => Invoice, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invoiceId' })
  invoice?: Invoice | null;

  @Column({ type: 'jsonb', nullable: true })
  result: InvoiceJobResult | null;

  @Column({
    type: 'enum',
    enum: InvoiceJobStatus,
    enumName: 'invoice_jobs_status_enum',
    default: InvoiceJobStatus.PENDING,
  })
  status: InvoiceJobStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'uuid', nullable: true })
  lockToken: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 5 })
  maxAttempts: number;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  nextRetryAt: Date;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({
    type: 'enum',
    enum: InvoiceJobCallbackStatus,
    enumName: 'invoice_jobs_callback_status_enum',
    default: InvoiceJobCallbackStatus.PENDING,
  })
  callbackStatus: InvoiceJobCallbackStatus;

  @Column({ type: 'timestamptz', nullable: true })
  callbackLockedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  callbackLockedUntil: Date | null;

  @Column({ type: 'uuid', nullable: true })
  callbackLockToken: string | null;

  @Column({ type: 'int', default: 0 })
  callbackAttempts: number;

  @Column({ type: 'int', default: 5 })
  callbackMaxAttempts: number;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  callbackNextRetryAt: Date;

  @Column({ type: 'text', nullable: true })
  callbackLastError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  callbackDeliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
