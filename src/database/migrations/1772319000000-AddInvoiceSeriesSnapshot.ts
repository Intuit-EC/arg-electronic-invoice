import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInvoiceSeriesSnapshot1772319000000 implements MigrationInterface {
  name = 'AddInvoiceSeriesSnapshot1772319000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invoice" ADD "establecimiento" character varying(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice" ADD "puntoEmision" character varying(3)`,
    );
    await queryRunner.query(
      `UPDATE "invoice" i
       SET "establecimiento" = iss."establecimiento",
           "puntoEmision" = iss."puntoEmision"
       FROM "issuer" iss
       WHERE i."issuerId" = iss."id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice" ALTER COLUMN "establecimiento" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice" ALTER COLUMN "puntoEmision" SET NOT NULL`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9e36afac433c2697cf6a8fddd1"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f214df5ec0f6f53ef48f2ae47b" ON "invoice" ("issuerId", "establecimiento", "puntoEmision", "secuencial") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f214df5ec0f6f53ef48f2ae47b"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_9e36afac433c2697cf6a8fddd1" ON "invoice" ("issuerId", "secuencial") `,
    );
    await queryRunner.query(`ALTER TABLE "invoice" DROP COLUMN "puntoEmision"`);
    await queryRunner.query(
      `ALTER TABLE "invoice" DROP COLUMN "establecimiento"`,
    );
  }
}
