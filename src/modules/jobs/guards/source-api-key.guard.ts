import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { InvoiceJobSourceSystem } from '../entities/invoice-job.entity';

export interface AuthenticatedJobRequest extends Request {
  authenticatedSourceSystem?: InvoiceJobSourceSystem;
}

@Injectable()
export class SourceApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(SourceApiKeyGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedJobRequest>();
    const body: unknown = request.body;
    const sourceSystem =
      body && typeof body === 'object' && 'sourceSystem' in body
        ? ((body as { sourceSystem?: unknown }).sourceSystem as
            | InvoiceJobSourceSystem
            | undefined)
        : undefined;
    const receivedKey = request.header('x-api-key') || '';
    const expectedKey = this.getExpectedKey(sourceSystem);

    if (
      !expectedKey ||
      !receivedKey ||
      !this.safeEqual(receivedKey, expectedKey)
    ) {
      this.logger.warn(
        `Intento de enqueue no autorizado para ${sourceSystem || 'UNKNOWN'}`,
      );
      throw new UnauthorizedException('Credenciales de origen inválidas');
    }

    request.authenticatedSourceSystem = sourceSystem;
    return true;
  }

  private getExpectedKey(source?: InvoiceJobSourceSystem): string {
    if (source === InvoiceJobSourceSystem.ZENNTRAL) {
      return this.configService.get<string>('jobs.apiKeys.zenntral') || '';
    }
    if (source === InvoiceJobSourceSystem.FACTURACION_BCA) {
      return (
        this.configService.get<string>('jobs.apiKeys.facturacionBca') || ''
      );
    }
    return '';
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
