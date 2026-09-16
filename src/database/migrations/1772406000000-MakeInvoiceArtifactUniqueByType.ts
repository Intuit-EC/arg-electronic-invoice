import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeInvoiceArtifactUniqueByType1772406000000 implements MigrationInterface {
  name = 'MakeInvoiceArtifactUniqueByType1772406000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "invoice_artifact" a
       USING "invoice_artifact" b
       WHERE a."invoiceId" = b."invoiceId"
         AND a."type" = b."type"
         AND (
           a."createdAt" < b."createdAt"
           OR (a."createdAt" = b."createdAt" AND a."id" < b."id")
         )`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_3d710b380c11a39df12cce9d12"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_3d710b380c11a39df12cce9d12" ON "invoice_artifact" ("invoiceId", "type") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_3d710b380c11a39df12cce9d12"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3d710b380c11a39df12cce9d12" ON "invoice_artifact" ("invoiceId", "type") `,
    );
  }
}
