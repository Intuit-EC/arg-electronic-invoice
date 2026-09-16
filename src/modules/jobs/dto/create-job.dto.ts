import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IssueInvoiceDto } from '../../invoice/dto';
import { InvoiceJobSourceSystem } from '../entities/invoice-job.entity';

export class CreateJobDto {
  @ApiProperty({ enum: InvoiceJobSourceSystem })
  @IsEnum(InvoiceJobSourceSystem)
  sourceSystem: InvoiceJobSourceSystem;

  @ApiPropertyOptional({
    description: 'Obligatorio para ZENNTRAL y omitido para FACTURACION_BCA',
  })
  @ValidateIf(
    (dto: CreateJobDto) =>
      dto.sourceSystem === InvoiceJobSourceSystem.ZENNTRAL ||
      dto.tenantId !== undefined,
  )
  @IsDefined()
  @IsString()
  @MaxLength(100)
  tenantId?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(150)
  sourceInvoiceId: string;

  @ApiProperty({ description: 'Clave de acceso SRI de 49 dígitos' })
  @IsString()
  @Matches(/^\d{49}$/)
  accessKey: string;

  @ApiProperty({ type: IssueInvoiceDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => IssueInvoiceDto)
  payload: IssueInvoiceDto;

  @ApiProperty()
  @IsString()
  @MaxLength(2048)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'callbackUrl debe ser una URL HTTP(S) válida' },
  )
  callbackUrl: string;
}
