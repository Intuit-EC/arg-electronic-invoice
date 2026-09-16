import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, EntityManager, FindOptionsWhere } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  Invoice,
  InvoiceDetail,
  InvoiceDetailTax,
  InvoicePayment,
  InvoiceArtifact,
  InvoiceEvent,
  Issuer,
  InvoiceStatus,
  SriReceptionStatus,
  SriAuthorizationStatus,
  ArtifactType,
  InvoiceEventType,
  AmbienteType,
} from './entities';
import {
  CreateInvoiceDto,
  IssueInvoiceDto,
  IssueInvoiceResponseDto,
  QueryInvoiceDto,
  InvoiceResponseDto,
  PaginatedInvoiceResponseDto,
} from './dto';
import { XmlBuilderService } from '../xml-builder/xml-builder.service';
import { SignatureService } from '../signature/signature.service';
import { SriAuthorizationResponse, SriService } from '../sri/sri.service';
import { StorageService } from '../storage/storage.service';
import {
  generateAccessKey,
  generateNumericCode,
  parseAccessKey,
  validateAccessKey,
} from '../../shared/utils/access-key.util';
import {
  formatDateForSri,
  getCurrentDateForSri,
} from '../../shared/utils/date.util';
import {
  TipoComprobante,
  TipoEmision,
} from '../../shared/constants/sri.constants';
import { PdfGeneratorService } from '../pdf-generator/pdf-generator.service';
import {
  SignatureConfigurationError,
  SriDefinitiveRejectionError,
  SriDomainError,
  SriTemporaryError,
} from '../../shared/errors/sri.errors';

export interface EnqueuedInvoiceResult {
  outcome: 'AUTHORIZED' | 'PENDING' | 'REJECTED';
  invoice: IssueInvoiceResponseDto;
  authorization?: {
    number: string;
    authorizedAt: Date;
  };
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectRepository(InvoiceDetail)
    private readonly detailRepository: Repository<InvoiceDetail>,
    @InjectRepository(InvoiceDetailTax)
    private readonly detailTaxRepository: Repository<InvoiceDetailTax>,
    @InjectRepository(InvoicePayment)
    private readonly paymentRepository: Repository<InvoicePayment>,
    @InjectRepository(InvoiceArtifact)
    private readonly artifactRepository: Repository<InvoiceArtifact>,
    @InjectRepository(InvoiceEvent)
    private readonly eventRepository: Repository<InvoiceEvent>,
    @InjectRepository(Issuer)
    private readonly issuerRepository: Repository<Issuer>,
    private readonly xmlBuilderService: XmlBuilderService,
    private readonly signatureService: SignatureService,
    private readonly sriService: SriService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
    private readonly pdfGeneratorService: PdfGeneratorService,
  ) {}

  /**
   * Crear una nueva factura
   */
  async create(
    createInvoiceDto: CreateInvoiceDto,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.createInvoiceRecord(createInvoiceDto);
    return this.mapToResponseDto(invoice);
  }

  /**
   * Recibir factura externa del ERP/POS y procesarla en el flujo de autorización fiscal.
   * La clave de acceso y el secuencial son propiedad del sistema emisor externo.
   */
  async issue(
    issueInvoiceDto: IssueInvoiceDto,
  ): Promise<IssueInvoiceResponseDto> {
    return (await this.processEnqueuedInvoice(issueInvoiceDto)).invoice;
  }

  async processEnqueuedInvoice(
    issueInvoiceDto: IssueInvoiceDto,
  ): Promise<EnqueuedInvoiceResult> {
    const existingInvoice = await this.findOneEntityByClaveAcceso(
      issueInvoiceDto.claveAcceso,
    );

    let processedInvoice: Invoice;

    if (existingInvoice) {
      this.logger.log(
        `Invoice issue request is idempotent. Reusing invoice ${existingInvoice.id} for claveAcceso ${issueInvoiceDto.claveAcceso}`,
      );
      processedInvoice = await this.resumeIssueFlow(existingInvoice);
    } else {
      const invoice = await this.createInvoiceRecord(
        issueInvoiceDto,
        issueInvoiceDto.establecimiento,
        issueInvoiceDto.puntoEmision,
        issueInvoiceDto.secuencial,
        issueInvoiceDto.claveAcceso,
      );
      processedInvoice = await this.processAuthorizationFlow(invoice);
    }

    const response = this.mapIssueResponseDto(processedInvoice);

    if (
      processedInvoice.status === InvoiceStatus.AUTHORIZED &&
      processedInvoice.authorizationNumber &&
      processedInvoice.authorizedAt
    ) {
      return {
        outcome: 'AUTHORIZED',
        invoice: response,
        authorization: {
          number: processedInvoice.authorizationNumber,
          authorizedAt: processedInvoice.authorizedAt,
        },
      };
    }

    if (processedInvoice.status === InvoiceStatus.NOT_AUTHORIZED) {
      return { outcome: 'REJECTED', invoice: response };
    }

    return { outcome: 'PENDING', invoice: response };
  }

  /**
   * Listar todas las facturas con filtros
   */
  async findAll(query: QueryInvoiceDto): Promise<PaginatedInvoiceResponseDto> {
    const { page = 1, limit = 10, ...filters } = query;
    const skip = (page - 1) * limit;

    const where: FindOptionsWhere<Invoice> = {};

    if (filters.issuerId) where.issuerId = filters.issuerId;
    if (filters.status) where.status = filters.status;
    if (filters.sriReceptionStatus)
      where.sriReceptionStatus = filters.sriReceptionStatus;
    if (filters.sriAuthorizationStatus)
      where.sriAuthorizationStatus = filters.sriAuthorizationStatus;
    if (filters.clienteIdentificacion)
      where.clienteIdentificacion = filters.clienteIdentificacion;

    if (filters.fechaInicio && filters.fechaFin) {
      where.fechaEmision = Between(filters.fechaInicio, filters.fechaFin);
    }

    const [invoices, total] = await this.invoiceRepository.findAndCount({
      where,
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
      relations: ['detalles', 'pagos'],
    });

    return {
      data: invoices.map((inv) => this.mapToResponseDto(inv)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Obtener una factura por ID
   */
  async findOne(id: string): Promise<InvoiceResponseDto> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id },
      relations: ['detalles', 'detalles.impuestos', 'pagos', 'issuer'],
    });

    if (!invoice) {
      throw new NotFoundException(`Factura con ID ${id} no encontrada`);
    }

    return this.mapToResponseDto(invoice);
  }

  /**
   * Obtener una factura por clave de acceso
   */
  async findOneByClaveAcceso(
    claveAcceso: string,
  ): Promise<IssueInvoiceResponseDto> {
    const invoice = await this.findOneEntityByClaveAcceso(claveAcceso);

    if (!invoice) {
      throw new NotFoundException(
        `Factura con claveAcceso ${claveAcceso} no encontrada`,
      );
    }

    return this.mapIssueResponseDto(invoice);
  }

  /**
   * Obtener un artefacto (XML, PDF, respuesta SRI) de una factura
   */
  async getArtifact(
    invoiceId: string,
    type: ArtifactType,
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    if (type === ArtifactType.RIDE_PDF) {
      // Para RIDE, buscamos el XML_AUTHORIZED y generamos el PDF al vuelo
      const xmlArtifact = await this.artifactRepository.findOne({
        where: { invoiceId, type: ArtifactType.XML_AUTHORIZED },
      });

      if (!xmlArtifact || (!xmlArtifact.content && !xmlArtifact.storageKey)) {
        throw new NotFoundException(
          `Factura ${invoiceId} no cuenta a\u00fan con un XML autorizado para generar el RIDE`,
        );
      }

      const invoice = await this.invoiceRepository.findOne({
        where: { id: invoiceId },
      });

      let xmlContent = xmlArtifact.content;
      if (!xmlContent && xmlArtifact.storageKey) {
        const fileBuffer = await this.storageService.get(
          xmlArtifact.storageKey,
        );
        xmlContent = fileBuffer.toString('utf8');
      }

      if (!xmlContent) {
        throw new InternalServerErrorException(
          `No se pudo recuperar el XML autorizado de la factura ${invoiceId}`,
        );
      }

      const buffer = await this.pdfGeneratorService.generateRideFromXml(
        xmlContent,
        {
          numeroAutorizacion: invoice?.authorizationNumber,
          fechaAutorizacion: invoice?.authorizedAt,
        },
      );

      return {
        buffer,
        mimeType: 'application/pdf',
        filename: `${invoiceId}_RIDE.pdf`,
      };
    }

    // Para otros tipos de artefactos
    const artifact = await this.artifactRepository.findOne({
      where: { invoiceId, type },
    });

    if (!artifact) {
      throw new NotFoundException(
        `Artefacto ${type} no encontrado para factura ${invoiceId}`,
      );
    }

    let buffer: Buffer;

    if (artifact.content) {
      // XML, JSON: est\u00e1 en la columna content de la DB
      buffer = Buffer.from(artifact.content, 'utf8');
    } else if (artifact.storageKey) {
      // PDF (por si hubieran PDFs hist\u00f3ricos): est\u00e1 en Cloud Storage
      buffer = await this.storageService.get(artifact.storageKey);
    } else {
      throw new InternalServerErrorException(
        `Artefacto ${type} no tiene contenido ni storageKey`,
      );
    }

    // Determinar extensi\u00f3n basado en el mimeType o el ArtifactType
    let extension = 'dat';
    if (artifact.mimeType === 'application/xml' || type.includes('XML')) {
      extension = 'xml';
    } else if (
      artifact.mimeType === 'application/json' ||
      type.includes('RESPONSE')
    ) {
      extension = 'json';
    }

    return {
      buffer,
      mimeType: artifact.mimeType || 'application/octet-stream',
      filename: `${invoiceId}_${type}.${extension}`,
    };
  }

  /**
   * Obtener un artefacto usando la clave de acceso como llave funcional
   */
  async getArtifactByClaveAcceso(
    claveAcceso: string,
    type: ArtifactType,
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const invoice = await this.invoiceRepository.findOne({
      where: { claveAcceso },
      select: { id: true },
    });

    if (!invoice) {
      throw new NotFoundException(
        `Factura con claveAcceso ${claveAcceso} no encontrada`,
      );
    }

    return this.getArtifact(invoice.id, type);
  }

  /**
   * Firmar y enviar factura al SRI
   */
  async authorize(id: string): Promise<InvoiceResponseDto> {
    this.logger.log(`Authorizing invoice: ${id}`);
    const invoice = await this.findOneEntity(id);

    if (invoice.status === InvoiceStatus.AUTHORIZED) {
      throw new BadRequestException('La factura ya está autorizada');
    }

    const processedInvoice = await this.processAuthorizationFlow(invoice);
    this.logger.log(`Invoice ${id} authorization process completed`);

    return this.mapToResponseDto(processedInvoice);
  }

  /**
   * Consultar autorización en el SRI
   */
  async checkAuthorization(id: string): Promise<InvoiceResponseDto> {
    const invoice = await this.findOneEntity(id);

    if (!invoice.claveAcceso) {
      throw new BadRequestException('La factura no tiene clave de acceso');
    }

    const { invoice: updatedInvoice } =
      await this.checkAndPersistAuthorization(invoice);
    return this.mapToResponseDto(updatedInvoice);
  }

  /**
   * Reintentar autorización
   */
  async retry(id: string): Promise<InvoiceResponseDto> {
    const invoice = await this.findOneEntity(id);

    if (invoice.status === InvoiceStatus.AUTHORIZED) {
      throw new BadRequestException('La factura ya está autorizada');
    }

    if (invoice.retryCount >= 5) {
      throw new BadRequestException(
        'Se alcanzó el límite máximo de reintentos',
      );
    }

    await this.createEvent(
      invoice.id,
      InvoiceEventType.RETRY,
      'Reintentando autorización',
    );

    return this.mapToResponseDto(await this.processAuthorizationFlow(invoice));
  }

  /**
   * Generar secuencial
   */
  private async generateSecuencial(
    issuerId: string,
    establecimiento: string,
    puntoEmision: string,
    manager: EntityManager = this.invoiceRepository.manager,
  ): Promise<string> {
    const invoiceRepository = manager.getRepository(Invoice);

    const lastInvoice = await invoiceRepository.findOne({
      where: { issuerId, establecimiento, puntoEmision },
      order: { secuencial: 'DESC' },
    });

    let nextSecuencial = 1;
    if (lastInvoice && lastInvoice.secuencial) {
      nextSecuencial = parseInt(lastInvoice.secuencial, 10) + 1;
    }

    return nextSecuencial.toString().padStart(9, '0');
  }

  private async normalizeAndValidateSecuencial(
    issuerId: string,
    establecimiento: string,
    puntoEmision: string,
    secuencial: string,
    manager: EntityManager = this.invoiceRepository.manager,
  ): Promise<string> {
    const normalizedSecuencial = secuencial.trim().padStart(9, '0');

    if (!/^\d{9}$/.test(normalizedSecuencial)) {
      throw new BadRequestException(
        'El secuencial debe contener entre 1 y 9 dígitos numéricos',
      );
    }

    const invoiceRepository = manager.getRepository(Invoice);

    const existingInvoice = await invoiceRepository.findOne({
      where: {
        issuerId,
        establecimiento,
        puntoEmision,
        secuencial: normalizedSecuencial,
      },
    });

    if (existingInvoice) {
      throw new BadRequestException(
        `Ya existe una factura con ${establecimiento}-${puntoEmision}-${normalizedSecuencial} para este emisor`,
      );
    }

    return normalizedSecuencial;
  }

  /**
   * Generar clave de acceso
   */
  private async generateClaveAcceso(invoice: Invoice): Promise<string> {
    const issuer = invoice.issuer;

    const claveAcceso = generateAccessKey({
      fecha: invoice.fechaEmision,
      tipoComprobante: TipoComprobante.FACTURA,
      ruc: issuer.ruc,
      ambiente: issuer.ambiente === AmbienteType.PRODUCCION ? '2' : '1',
      serie: invoice.establecimiento + invoice.puntoEmision,
      numeroComprobante: invoice.secuencial,
      codigoNumerico: generateNumericCode(),
      tipoEmision: TipoEmision.NORMAL,
    });

    // Validar que la clave es correcta
    if (!validateAccessKey(claveAcceso)) {
      throw new InternalServerErrorException(
        'Error al generar clave de acceso válida',
      );
    }

    return claveAcceso;
  }

  private async resolveClaveAcceso(
    invoice: Invoice,
    providedClaveAcceso?: string,
    manager: EntityManager = this.invoiceRepository.manager,
  ): Promise<string> {
    if (!providedClaveAcceso) {
      return this.generateClaveAcceso(invoice);
    }

    const claveAcceso = providedClaveAcceso.trim();

    if (!validateAccessKey(claveAcceso)) {
      throw new BadRequestException(
        'La claveAcceso enviada por el cliente no es válida',
      );
    }

    const parsedAccessKey = parseAccessKey(claveAcceso);
    if (!parsedAccessKey) {
      throw new BadRequestException(
        'No se pudo interpretar la claveAcceso enviada por el cliente',
      );
    }

    const issuer = invoice.issuer;
    const expectedFecha = invoice.fechaEmision.replace(/\//g, '');
    const expectedSerie = `${invoice.establecimiento}${invoice.puntoEmision}`;
    const hasValidSriAmbiente =
      parsedAccessKey.ambiente === '1' || parsedAccessKey.ambiente === '2';

    if (!hasValidSriAmbiente) {
      throw new BadRequestException(
        'La claveAcceso enviada por el cliente contiene un ambiente SRI inválido',
      );
    }

    const requestedAmbienteCode = this.getSriAmbienteCodeFromSelection(
      invoice.ambiente,
    );

    if (
      requestedAmbienteCode &&
      parsedAccessKey.ambiente !== requestedAmbienteCode
    ) {
      throw new BadRequestException(
        'La claveAcceso enviada por el cliente no coincide con el ambiente solicitado',
      );
    }

    if (
      parsedAccessKey.fecha !== expectedFecha ||
      parsedAccessKey.tipoComprobante !== TipoComprobante.FACTURA ||
      parsedAccessKey.ruc !== issuer.ruc ||
      parsedAccessKey.serie !== expectedSerie ||
      parsedAccessKey.numeroComprobante !== invoice.secuencial ||
      parsedAccessKey.tipoEmision !== TipoEmision.NORMAL
    ) {
      throw new BadRequestException(
        'La claveAcceso enviada por el cliente no coincide con los datos fiscales de la factura',
      );
    }

    const invoiceRepository = manager.getRepository(Invoice);

    const existingInvoice = await invoiceRepository.findOne({
      where: { claveAcceso },
    });

    if (existingInvoice) {
      throw new BadRequestException(
        `Ya existe una factura con la claveAcceso ${claveAcceso}`,
      );
    }

    return claveAcceso;
  }

  /**
   * Generar XML de la factura
   */
  private generateXml(invoice: Invoice): string {
    const issuer = invoice.issuer;
    const ambiente = this.resolveSriAmbienteCode(invoice);

    const invoiceData = {
      issuer: {
        ambiente,
        tipoEmision: TipoEmision.NORMAL,
        razonSocial: issuer.razonSocial,
        nombreComercial: issuer.nombreComercial || issuer.razonSocial,
        ruc: issuer.ruc,
        claveAcceso: invoice.claveAcceso,
        codDoc: TipoComprobante.FACTURA,
        estab: invoice.establecimiento,
        ptoEmi: invoice.puntoEmision,
        secuencial: invoice.secuencial,
        dirMatriz: issuer.direccionMatriz,
      },
      invoice: {
        fechaEmision: invoice.fechaEmision,
        dirEstablecimiento: issuer.direccionMatriz,
        obligadoContabilidad: issuer.obligadoContabilidad ? 'SI' : 'NO',
        tipoIdentificacionComprador: invoice.clienteTipoIdentificacion,
        razonSocialComprador: invoice.clienteRazonSocial,
        identificacionComprador: invoice.clienteIdentificacion,
        direccionComprador: invoice.clienteDireccion,
        totalSinImpuestos: invoice.totalSinImpuestos,
        totalDescuento: invoice.totalDescuento,
        totalConImpuestos: this.calculateTotalImpuestos(invoice),
        propina: invoice.propina,
        importeTotal: invoice.importeTotal,
        moneda: invoice.moneda,
      },
      detalles: invoice.detalles,
      pagos: invoice.pagos,
      infoAdicional: invoice.infoAdicional || {},
    };

    return this.xmlBuilderService.buildInvoiceXml(invoiceData);
  }

  private resolveSriAmbienteCode(invoice: Invoice): '1' | '2' {
    const requestedAmbienteCode = this.getSriAmbienteCodeFromSelection(
      invoice.ambiente,
    );

    if (requestedAmbienteCode) {
      return requestedAmbienteCode;
    }

    return this.getSriAmbienteCodeFromSelection(invoice.issuer.ambiente) || '1';
  }

  private getSriAmbienteCodeFromSelection(
    ambiente?: AmbienteType | null,
  ): '1' | '2' | null {
    if (ambiente === AmbienteType.PRODUCCION) {
      return '2';
    }

    if (ambiente === AmbienteType.PRUEBAS) {
      return '1';
    }

    return null;
  }

  /**
   * Calcular total de impuestos
   */
  private calculateTotalImpuestos(invoice: Invoice): any[] {
    const details = invoice.detalles || [];
    const impuestosMap = new Map();

    for (const detail of details) {
      for (const tax of detail.impuestos) {
        const key = `${tax.codigo}-${tax.codigoPorcentaje}`;
        if (!impuestosMap.has(key)) {
          impuestosMap.set(key, {
            codigo: tax.codigo,
            codigoPorcentaje: tax.codigoPorcentaje,
            baseImponible: 0,
            valor: 0,
          });
        }
        const current = impuestosMap.get(key);
        current.baseImponible += Number(tax.baseImponible);
        current.valor += Number(tax.valor);
      }
    }

    return Array.from(impuestosMap.values());
  }

  /**
   * Guardar artefacto
   */
  private async saveArtifact(
    invoiceId: string,
    type: ArtifactType,
    content: string,
    mimeType: string,
  ): Promise<void> {
    const artifactData: Partial<InvoiceArtifact> = {
      invoiceId,
      type,
      hashSha256: crypto.createHash('sha256').update(content).digest('hex'),
      mimeType,
      size: Buffer.byteLength(content, 'utf8'),
      storageKey: null,
      content: null,
    };
    this.logger.debug(
      `Saving artifact for invoice ${invoiceId}, type ${type}, size ${artifactData.size} bytes, hash ${artifactData.hashSha256}`,
    );
    // Lógica de almacenamiento:
    // - XMLs y JSONs: guardar en DB (columna content)
    // - PDFs: guardar en Cloud Storage (columna storageKey)
    if (type === ArtifactType.RIDE_PDF) {
      // PDF: usar Cloud Storage
      const storageKey = await this.saveToStorage(invoiceId, type, content);
      artifactData.storageKey = storageKey;
      // No guardar content en DB para PDFs (son archivos binarios grandes)
    } else {
      // XML o JSON: guardar directamente en DB
      artifactData.content = content;
      // No usar filesystem para XMLs/JSONs
    }
    console.log(
      `Saving artifact for invoice ${invoiceId}, type ${type}, size ${artifactData.size} bytes, hash ${artifactData.hashSha256}`,
    );
    await this.artifactRepository.upsert(artifactData, ['invoiceId', 'type']);
  }

  /**
   * Guardar archivos binarios en Cloud Storage (solo PDFs)
   */
  private async saveToStorage(
    invoiceId: string,
    type: ArtifactType,
    content: string,
  ): Promise<string> {
    const extension = type === ArtifactType.RIDE_PDF ? 'pdf' : 'dat';
    const fileName = `${invoiceId}_${type}_${Date.now()}.${extension}`;
    const storageKey = `invoices/${invoiceId}/${fileName}`;

    // Usar StorageService (soporta local, GCS, etc)
    await this.storageService.save(storageKey, content);

    return storageKey;
  }

  /**
   * Crear evento
   */
  private async createEvent(
    invoiceId: string,
    type: InvoiceEventType,
    message: string,
    payload?: Record<string, any>,
  ): Promise<void> {
    const event = this.eventRepository.create({
      invoiceId,
      type,
      message,
      payload,
    });

    await this.eventRepository.save(event);
  }

  /**
   * Obtener entidad completa
   */
  private async findOneEntity(id: string): Promise<Invoice> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id },
      relations: ['detalles', 'detalles.impuestos', 'pagos', 'issuer'],
    });

    if (!invoice) {
      throw new NotFoundException(`Factura con ID ${id} no encontrada`);
    }

    return invoice;
  }

  private async findOneEntityByClaveAcceso(
    claveAcceso: string,
  ): Promise<Invoice | null> {
    return this.invoiceRepository.findOne({
      where: { claveAcceso },
      relations: ['detalles', 'detalles.impuestos', 'pagos', 'issuer'],
    });
  }

  private async checkAndPersistAuthorization(invoice: Invoice): Promise<{
    invoice: Invoice;
    response: SriAuthorizationResponse;
  }> {
    const previousStatus = invoice.status;
    invoice.sriAuthorizationStatus = SriAuthorizationStatus.PENDING;
    await this.invoiceRepository.save(invoice);

    const response = await this.sriService.checkAuthorization(
      invoice.claveAcceso,
    );

    await this.saveArtifact(
      invoice.id,
      ArtifactType.RESPONSE_AUTH,
      JSON.stringify(response),
      'application/json',
    );

    if (response.estado === 'AUTORIZADO') {
      if (!response.numeroAutorizacion) {
        throw new SriTemporaryError(
          'El SRI respondió AUTORIZADO sin número de autorización',
          'SRI_AUTHORIZATION_INCOMPLETE',
        );
      }

      invoice.status = InvoiceStatus.AUTHORIZED;
      invoice.sriAuthorizationStatus = SriAuthorizationStatus.AUTORIZADO;
      invoice.authorizationNumber = response.numeroAutorizacion;
      invoice.authorizedAt = this.parseAuthorizationDate(
        response.fechaAutorizacion,
      );
      invoice.lastError = null;

      if (response.comprobante) {
        await this.saveArtifact(
          invoice.id,
          ArtifactType.XML_AUTHORIZED,
          response.comprobante,
          'application/xml',
        );
      }

      if (previousStatus !== InvoiceStatus.AUTHORIZED) {
        await this.createEvent(
          invoice.id,
          InvoiceEventType.AUTHORIZED,
          'Factura autorizada por el SRI',
          { authorizationNumber: response.numeroAutorizacion },
        );
      }
    } else if (response.estado === 'NO AUTORIZADO') {
      invoice.status = InvoiceStatus.NOT_AUTHORIZED;
      invoice.sriAuthorizationStatus = SriAuthorizationStatus.NO_AUTORIZADO;
      invoice.lastError = this.formatSriMessages(
        response.mensajes,
        'No autorizada por el SRI',
      );

      if (previousStatus !== InvoiceStatus.NOT_AUTHORIZED) {
        await this.createEvent(
          invoice.id,
          InvoiceEventType.NOT_AUTHORIZED,
          `No autorizada: ${invoice.lastError}`,
        );
      }
    } else if (response.estado === 'EN PROCESO') {
      invoice.sriAuthorizationStatus = SriAuthorizationStatus.EN_PROCESAMIENTO;
    } else {
      invoice.sriAuthorizationStatus = SriAuthorizationStatus.PENDING;
    }

    await this.invoiceRepository.save(invoice);
    return { invoice: await this.findOneEntity(invoice.id), response };
  }

  private parseAuthorizationDate(value: string | null): Date {
    if (!value) return new Date();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private formatSriMessages(
    messages: SriAuthorizationResponse['mensajes'],
    fallback: string,
  ): string {
    if (!messages.length) return fallback;

    return messages
      .map((message) => {
        const additional = message.informacionAdicional
          ? ` - ${message.informacionAdicional}`
          : '';
        return `[${message.identificador}] ${message.mensaje}${additional}`;
      })
      .join(' | ');
  }

  private async processAuthorizationFlow(invoice: Invoice): Promise<Invoice> {
    this.validateInvoiceEntityTotals(invoice);

    try {
      if (!invoice.claveAcceso) {
        invoice.claveAcceso = await this.generateClaveAcceso(invoice);
        await this.invoiceRepository.save(invoice);
      }

      const preflight = await this.checkAndPersistAuthorization(invoice);
      invoice = preflight.invoice;

      if (
        preflight.response.estado === 'AUTORIZADO' ||
        preflight.response.estado === 'NO AUTORIZADO' ||
        preflight.response.estado === 'EN PROCESO'
      ) {
        return invoice;
      }

      if (invoice.sriReceptionStatus === SriReceptionStatus.RECEIVED) {
        return invoice;
      }

      const xmlUnsigned =
        (await this.getArtifactContent(
          invoice.id,
          ArtifactType.XML_UNSIGNED,
        )) || (await this.generateAndPersistUnsignedXml(invoice));

      const xmlSigned =
        (await this.getArtifactContent(invoice.id, ArtifactType.XML_SIGNED)) ||
        (await this.signAndPersistXml(invoice, xmlUnsigned));

      await this.sendSignedXmlToSri(invoice, xmlSigned);

      if (
        invoice.status !== InvoiceStatus.AUTHORIZED &&
        invoice.sriAuthorizationStatus !== SriAuthorizationStatus.AUTORIZADO
      ) {
        await this.checkAndPersistAuthorization(invoice);
      }

      return this.findOneEntity(invoice.id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error authorizing invoice ${invoice.id}: ${message}`);

      invoice.status = InvoiceStatus.ERROR;
      invoice.lastError = message;
      invoice.retryCount += 1;
      await this.invoiceRepository.save(invoice);

      await this.createEvent(
        invoice.id,
        InvoiceEventType.ERROR,
        `Error: ${message}`,
        { error: error instanceof Error ? error.stack : undefined },
      );

      if (error instanceof SriDomainError) throw error;
      throw new SriTemporaryError(
        `Error inesperado al autorizar factura: ${message}`,
        'INVOICE_PROCESSING_ERROR',
        { cause: error },
      );
    }
  }

  private async resumeIssueFlow(invoice: Invoice): Promise<Invoice> {
    if (
      invoice.status === InvoiceStatus.AUTHORIZED ||
      invoice.status === InvoiceStatus.NOT_AUTHORIZED ||
      invoice.status === InvoiceStatus.CANCELLED
    ) {
      return invoice;
    }

    if (
      invoice.sriReceptionStatus === SriReceptionStatus.RECEIVED &&
      invoice.sriAuthorizationStatus === SriAuthorizationStatus.AUTORIZADO
    ) {
      return invoice;
    }

    return this.processAuthorizationFlow(invoice);
  }

  private async generateAndPersistUnsignedXml(
    invoice: Invoice,
  ): Promise<string> {
    let xmlUnsigned: string;
    try {
      xmlUnsigned = this.generateXml(invoice);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SriDefinitiveRejectionError(
        `No fue posible construir un XML fiscal válido: ${message}`,
        'INVOICE_XML_INVALID',
        { cause: error },
      );
    }
    this.logger.debug(
      `XML sin firmar generado para invoice ${invoice.id} (${Buffer.byteLength(xmlUnsigned, 'utf8')} bytes)`,
    );

    await this.saveArtifact(
      invoice.id,
      ArtifactType.XML_UNSIGNED,
      xmlUnsigned,
      'application/xml',
    );

    if (invoice.status === InvoiceStatus.DRAFT) {
      invoice.status = InvoiceStatus.PENDING_SIGNATURE;
      invoice.lastError = null;
      await this.invoiceRepository.save(invoice);
    }

    return xmlUnsigned;
  }

  private async signAndPersistXml(
    invoice: Invoice,
    xmlUnsigned: string,
  ): Promise<string> {
    let xmlSigned: string;
    try {
      xmlSigned = await this.signatureService.signXml(
        xmlUnsigned,
        invoice.issuer.certP12Path,
        invoice.issuer.certPasswordEncrypted,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SignatureConfigurationError(
        `No fue posible firmar la factura: ${message}`,
        'SIGNATURE_FAILED',
        { cause: error },
      );
    }

    this.logger.debug(
      `XML firmado generado para invoice ${invoice.id} (${Buffer.byteLength(xmlSigned, 'utf8')} bytes)`,
    );

    await this.saveArtifact(
      invoice.id,
      ArtifactType.XML_SIGNED,
      xmlSigned,
      'application/xml',
    );

    invoice.status = InvoiceStatus.SIGNED;
    invoice.lastError = null;
    await this.invoiceRepository.save(invoice);
    await this.createEvent(
      invoice.id,
      InvoiceEventType.SIGNED,
      'Factura firmada',
    );

    return xmlSigned;
  }

  private async sendSignedXmlToSri(
    invoice: Invoice,
    xmlSigned: string,
  ): Promise<void> {
    invoice.status = InvoiceStatus.SENDING;
    invoice.sriReceptionStatus = SriReceptionStatus.PENDING;
    await this.invoiceRepository.save(invoice);

    const receptionResponse = await this.sriService.sendToReception({
      claveAcceso: invoice.claveAcceso,
      xml: xmlSigned,
    });

    await this.saveArtifact(
      invoice.id,
      ArtifactType.RESPONSE_RECEPTION,
      JSON.stringify(receptionResponse),
      'application/json',
    );

    if (receptionResponse.estado === 'RECIBIDA') {
      invoice.sriReceptionStatus = SriReceptionStatus.RECEIVED;
      invoice.lastError = null;
      await this.invoiceRepository.save(invoice);
      await this.createEvent(
        invoice.id,
        InvoiceEventType.RECEIVED,
        'Recibida por el SRI',
      );
      return;
    }

    let errorMessage = 'Error desconocido en recepción';
    if (
      receptionResponse.comprobantes &&
      receptionResponse.comprobantes.length > 0
    ) {
      const comprobante = receptionResponse.comprobantes[0];
      if (comprobante.mensajes && comprobante.mensajes.length > 0) {
        const primerMensaje = comprobante.mensajes[0];
        errorMessage = `[${primerMensaje.identificador}] ${primerMensaje.mensaje}`;
        if (primerMensaje.informacionAdicional) {
          errorMessage += ` - ${primerMensaje.informacionAdicional}`;
        }
      }
    }

    invoice.status = InvoiceStatus.ERROR;
    invoice.sriReceptionStatus = SriReceptionStatus.DEVUELTA;
    invoice.lastError = errorMessage;
    await this.invoiceRepository.save(invoice);
    await this.createEvent(
      invoice.id,
      InvoiceEventType.ERROR,
      `Error en recepción: ${errorMessage}`,
    );

    throw new SriDefinitiveRejectionError(
      errorMessage,
      'SRI_RECEPTION_REJECTED',
    );
  }

  private async getArtifactContent(
    invoiceId: string,
    type: ArtifactType,
  ): Promise<string | null> {
    const artifact = await this.artifactRepository.findOne({
      where: { invoiceId, type },
    });

    if (!artifact) {
      return null;
    }

    if (artifact.content) {
      return artifact.content;
    }

    if (artifact.storageKey) {
      const fileBuffer = await this.storageService.get(artifact.storageKey);
      return fileBuffer.toString('utf8');
    }

    return null;
  }

  private async createInvoiceRecord(
    createInvoiceDto: CreateInvoiceDto,
    providedEstablecimiento?: string,
    providedPuntoEmision?: string,
    providedSecuencial?: string,
    providedClaveAcceso?: string,
  ): Promise<Invoice> {
    this.logger.log(
      `Creating invoice for issuer: ${createInvoiceDto.issuerId}`,
    );

    this.validateInvoiceTotals(createInvoiceDto);

    const {
      detalles,
      pagos,
      ambiente: providedAmbiente,
      establecimiento: _providedEstablecimiento,
      puntoEmision: _providedPuntoEmision,
      secuencial: _providedSecuencial,
      claveAcceso: _providedClaveAcceso,
      ...invoicePayload
    } = createInvoiceDto as CreateInvoiceDto & Partial<IssueInvoiceDto>;

    try {
      const savedInvoiceId = await this.invoiceRepository.manager.transaction(
        async (manager) => {
          const invoiceRepository = manager.getRepository(Invoice);
          const detailRepository = manager.getRepository(InvoiceDetail);
          const detailTaxRepository = manager.getRepository(InvoiceDetailTax);
          const paymentRepository = manager.getRepository(InvoicePayment);
          const eventRepository = manager.getRepository(InvoiceEvent);
          const issuerRepository = manager.getRepository(Issuer);

          const issuer = await issuerRepository.findOne({
            where: { id: createInvoiceDto.issuerId, isActive: true },
          });

          if (!issuer) {
            throw new NotFoundException('Emisor no encontrado');
          }

          const establecimiento =
            providedEstablecimiento || issuer.establecimiento;
          const puntoEmision = providedPuntoEmision || issuer.puntoEmision;
          const secuencial = providedSecuencial
            ? await this.normalizeAndValidateSecuencial(
                issuer.id,
                establecimiento,
                puntoEmision,
                providedSecuencial,
                manager,
              )
            : await this.generateSecuencial(
                issuer.id,
                establecimiento,
                puntoEmision,
                manager,
              );

          const invoice = invoiceRepository.create({
            ...invoicePayload,
            establecimiento,
            puntoEmision,
            secuencial,
            ambiente: providedAmbiente || null,
            status: InvoiceStatus.DRAFT,
            moneda: createInvoiceDto.moneda || 'DOLAR',
            totalDescuento: createInvoiceDto.totalDescuento || 0,
            propina: createInvoiceDto.propina || 0,
          });

          invoice.issuer = issuer;
          invoice.claveAcceso = await this.resolveClaveAcceso(
            invoice,
            providedClaveAcceso,
            manager,
          );

          const savedInvoice = await invoiceRepository.save(invoice);

          for (const detalleDto of detalles) {
            const { impuestos, ...detallePayload } = detalleDto;
            const detalle = detailRepository.create({
              ...detallePayload,
              invoiceId: savedInvoice.id,
            });
            await detailRepository.save(detalle);

            for (const impuestoDto of impuestos) {
              const impuesto = detailTaxRepository.create({
                ...impuestoDto,
                detailId: detalle.id,
              });
              await detailTaxRepository.save(impuesto);
            }
          }

          for (const pagoDto of pagos) {
            const pago = paymentRepository.create({
              ...pagoDto,
              invoiceId: savedInvoice.id,
            });
            await paymentRepository.save(pago);
          }

          const event = eventRepository.create({
            invoiceId: savedInvoice.id,
            type: InvoiceEventType.CREATED,
            message: providedSecuencial
              ? 'Factura creada con secuencial externo'
              : 'Factura creada',
          });
          await eventRepository.save(event);

          return savedInvoice.id;
        },
      );

      this.logger.log(`Invoice created with ID: ${savedInvoiceId}`);

      return this.findOneEntity(savedInvoiceId);
    } catch (error: any) {
      if (error?.code === '23505') {
        if (String(error?.detail || '').includes('claveAcceso')) {
          throw new BadRequestException(
            `Ya existe una factura con la claveAcceso ${providedClaveAcceso}`,
          );
        }

        throw new BadRequestException(
          'Ya existe una factura con los datos fiscales enviados',
        );
      }

      throw error;
    }
  }

  /**
   * Validar totales de la factura
   */
  private validateInvoiceTotals(dto: CreateInvoiceDto): void {
    // 1. Calcular suma de detalles
    const sumDetalles = dto.detalles.reduce((sum, d) => {
      return sum + Number(d.precioTotalSinImpuesto);
    }, 0);

    // Validar totalSinImpuestos
    const totalSinImpuestos = Number(dto.totalSinImpuestos);
    if (Math.abs(sumDetalles - totalSinImpuestos) > 0.01) {
      throw new BadRequestException(
        `totalSinImpuestos (${totalSinImpuestos}) no coincide con la suma de detalles (${sumDetalles.toFixed(2)})`,
      );
    }

    // 2. Calcular suma de impuestos
    let sumImpuestos = 0;
    dto.detalles.forEach((detalle) => {
      detalle.impuestos.forEach((imp) => {
        sumImpuestos += Number(imp.valor);
      });
    });

    // 3. Calcular importeTotal esperado
    const totalDescuento = Number(dto.totalDescuento || 0);
    const propina = Number(dto.propina || 0);
    const importeTotalEsperado =
      totalSinImpuestos + sumImpuestos + propina - totalDescuento;

    const importeTotal = Number(dto.importeTotal);
    if (Math.abs(importeTotal - importeTotalEsperado) > 0.01) {
      throw new BadRequestException(
        `importeTotal (${importeTotal}) no coincide con el cálculo esperado (${importeTotalEsperado.toFixed(2)}). ` +
          `Fórmula: totalSinImpuestos (${totalSinImpuestos}) + impuestos (${sumImpuestos.toFixed(2)}) + propina (${propina}) - descuentos (${totalDescuento})`,
      );
    }

    // 4. Validar que suma de pagos coincida con importeTotal
    const sumPagos = dto.pagos.reduce((sum, p) => sum + Number(p.total), 0);
    if (Math.abs(sumPagos - importeTotal) > 0.01) {
      throw new BadRequestException(
        `La suma de pagos (${sumPagos.toFixed(2)}) no coincide con importeTotal (${importeTotal})`,
      );
    }

    this.logger.debug('Validación de totales exitosa');
  }

  /**
   * Validar consistencia de totales usando la factura persistida en DB.
   * Previene firmar/enviar comprobantes con detalles/impuestos/pagos desalineados.
   */
  private validateInvoiceEntityTotals(invoice: Invoice): void {
    const sumDetalles = (invoice.detalles || []).reduce(
      (sum, d) => sum + Number(d.precioTotalSinImpuesto || 0),
      0,
    );
    const totalSinImpuestos = Number(invoice.totalSinImpuestos || 0);

    if (Math.abs(sumDetalles - totalSinImpuestos) > 0.01) {
      throw new BadRequestException(
        `Factura inconsistente: totalSinImpuestos (${totalSinImpuestos.toFixed(2)}) != suma de detalles (${sumDetalles.toFixed(2)})`,
      );
    }

    const sumImpuestos = (invoice.detalles || []).reduce((sum, detalle) => {
      const impuestos = detalle.impuestos || [];
      return (
        sum +
        impuestos.reduce((taxSum, imp) => taxSum + Number(imp.valor || 0), 0)
      );
    }, 0);

    const totalDescuento = Number(invoice.totalDescuento || 0);
    const propina = Number(invoice.propina || 0);
    const importeEsperado =
      totalSinImpuestos + sumImpuestos + propina - totalDescuento;
    const importeTotal = Number(invoice.importeTotal || 0);

    if (Math.abs(importeTotal - importeEsperado) > 0.01) {
      throw new BadRequestException(
        `Factura inconsistente: importeTotal (${importeTotal.toFixed(2)}) != cálculo esperado (${importeEsperado.toFixed(2)})`,
      );
    }

    const sumPagos = (invoice.pagos || []).reduce(
      (sum, p) => sum + Number(p.total || 0),
      0,
    );
    if (Math.abs(sumPagos - importeTotal) > 0.01) {
      throw new BadRequestException(
        `Factura inconsistente: suma de pagos (${sumPagos.toFixed(2)}) != importeTotal (${importeTotal.toFixed(2)})`,
      );
    }
  }

  /**
   * Mapear a DTO de respuesta
   */
  private mapToResponseDto(invoice: Invoice): InvoiceResponseDto {
    return {
      id: invoice.id,
      issuerId: invoice.issuerId,
      secuencial: invoice.secuencial,
      establecimiento: invoice.establecimiento,
      puntoEmision: invoice.puntoEmision,
      claveAcceso: invoice.claveAcceso,
      ambiente: invoice.ambiente || undefined,
      fechaEmision: invoice.fechaEmision,
      clienteTipoIdentificacion: invoice.clienteTipoIdentificacion,
      clienteIdentificacion: invoice.clienteIdentificacion,
      clienteRazonSocial: invoice.clienteRazonSocial,
      clienteDireccion: invoice.clienteDireccion,
      clienteEmail: invoice.clienteEmail,
      clienteTelefono: invoice.clienteTelefono,
      totalSinImpuestos: Number(invoice.totalSinImpuestos),
      totalDescuento: Number(invoice.totalDescuento),
      propina: Number(invoice.propina),
      importeTotal: Number(invoice.importeTotal),
      moneda: invoice.moneda,
      status: invoice.status,
      sriReceptionStatus: invoice.sriReceptionStatus,
      sriAuthorizationStatus: invoice.sriAuthorizationStatus,
      authorizationNumber: invoice.authorizationNumber,
      authorizedAt: invoice.authorizedAt,
      retryCount: invoice.retryCount,
      lastError: invoice.lastError,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
      detalles: invoice.detalles,
      pagos: invoice.pagos,
      infoAdicional: invoice.infoAdicional,
    };
  }

  private mapIssueResponseDto(invoice: Invoice): IssueInvoiceResponseDto {
    return {
      ...this.mapToResponseDto(invoice),
      artifacts: {
        signedXmlUrl:
          invoice.status !== InvoiceStatus.DRAFT
            ? `/invoices/${invoice.id}/artifacts/${ArtifactType.XML_SIGNED}`
            : undefined,
        authorizedXmlUrl:
          invoice.status === InvoiceStatus.AUTHORIZED
            ? `/invoices/${invoice.id}/artifacts/${ArtifactType.XML_AUTHORIZED}`
            : undefined,
      },
    };
  }
}
