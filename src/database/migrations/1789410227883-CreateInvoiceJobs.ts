import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInvoiceJobs1789410227883 implements MigrationInterface {
  name = 'CreateInvoiceJobs1789410227883';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."invoice_jobs_source_system_enum" AS ENUM('ZENNTRAL', 'FACTURACION_BCA')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."invoice_jobs_status_enum" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."invoice_jobs_callback_status_enum" AS ENUM('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED')`,
    );
    await queryRunner.query(`
      CREATE TABLE "invoice_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sourceSystem" "public"."invoice_jobs_source_system_enum" NOT NULL,
        "tenantId" character varying(100),
        "sourceInvoiceId" character varying(150) NOT NULL,
        "accessKey" character varying(49) NOT NULL,
        "payload" jsonb NOT NULL,
        "callbackUrl" character varying(2048) NOT NULL,
        "invoiceId" uuid,
        "result" jsonb,
        "status" "public"."invoice_jobs_status_enum" NOT NULL DEFAULT 'PENDING',
        "lockedAt" TIMESTAMPTZ,
        "lockedUntil" TIMESTAMPTZ,
        "lockToken" uuid,
        "attempts" integer NOT NULL DEFAULT 0,
        "maxAttempts" integer NOT NULL DEFAULT 5,
        "nextRetryAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "lastError" text,
        "callbackStatus" "public"."invoice_jobs_callback_status_enum" NOT NULL DEFAULT 'PENDING',
        "callbackLockedAt" TIMESTAMPTZ,
        "callbackLockedUntil" TIMESTAMPTZ,
        "callbackLockToken" uuid,
        "callbackAttempts" integer NOT NULL DEFAULT 0,
        "callbackMaxAttempts" integer NOT NULL DEFAULT 5,
        "callbackNextRetryAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "callbackLastError" text,
        "callbackDeliveredAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_invoice_jobs_access_key" CHECK ("accessKey" ~ '^[0-9]{49}$'),
        CONSTRAINT "CHK_invoice_jobs_attempts" CHECK ("attempts" >= 0 AND "maxAttempts" > 0),
        CONSTRAINT "CHK_invoice_jobs_callback_attempts" CHECK ("callbackAttempts" >= 0 AND "callbackMaxAttempts" > 0),
        CONSTRAINT "CHK_invoice_jobs_zenntral_tenant" CHECK ("sourceSystem" <> 'ZENNTRAL' OR "tenantId" IS NOT NULL),
        CONSTRAINT "FK_invoice_jobs_invoice" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_invoice_jobs_access_key" ON "invoice_jobs" ("accessKey")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_invoice_jobs_source_tenant_invoice" ON "invoice_jobs" ("sourceSystem", "tenantId", "sourceInvoiceId") WHERE "tenantId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_invoice_jobs_source_invoice_without_tenant" ON "invoice_jobs" ("sourceSystem", "sourceInvoiceId") WHERE "tenantId" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invoice_jobs_sri_claim" ON "invoice_jobs" ("status", "nextRetryAt", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invoice_jobs_callback_claim" ON "invoice_jobs" ("status", "callbackStatus", "callbackNextRetryAt", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "invoice_jobs"`);
    await queryRunner.query(
      `DROP TYPE "public"."invoice_jobs_callback_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."invoice_jobs_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."invoice_jobs_source_system_enum"`,
    );
  }
}
