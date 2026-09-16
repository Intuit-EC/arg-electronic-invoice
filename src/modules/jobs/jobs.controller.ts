import {
  Body,
  Controller,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CreateJobDto } from './dto/create-job.dto';
import { SourceApiKeyGuard } from './guards/source-api-key.guard';
import { EnqueueJobResponse } from './interfaces/job-result.interface';
import { JobsService } from './jobs.service';

@ApiTags('Jobs')
@ApiSecurity('x-api-key')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post('enqueue')
  @UseGuards(SourceApiKeyGuard)
  @ApiOperation({ summary: 'Encolar una factura para procesamiento asíncrono' })
  @ApiResponse({ status: 202, description: 'Factura encolada' })
  @ApiResponse({
    status: 200,
    description: 'Solicitud idempotente ya existente',
  })
  @ApiResponse({ status: 409, description: 'Conflicto de idempotencia' })
  async enqueue(
    @Body() dto: CreateJobDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EnqueueJobResponse> {
    const result = await this.jobsService.createJob(dto);
    response.status(result.created ? HttpStatus.ACCEPTED : HttpStatus.OK);

    return {
      jobId: result.job.id,
      status: result.job.status,
      accessKey: result.job.accessKey,
      enqueuedAt: result.job.createdAt,
    };
  }
}
