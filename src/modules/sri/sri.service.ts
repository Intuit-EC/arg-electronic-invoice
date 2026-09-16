import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { XMLParser } from 'fast-xml-parser';
import {
  SriDefinitiveRejectionError,
  SriDomainError,
  SriTemporaryError,
} from '../../shared/errors/sri.errors';

export interface SriMessage {
  identificador: string;
  mensaje: string;
  informacionAdicional: string;
  tipo: string;
}

export interface SriReceptionResponse {
  estado: string;
  comprobantes: Array<{
    claveAcceso: string;
    mensajes: SriMessage[];
  }>;
}

export interface SriAuthorizationResponse {
  estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'EN PROCESO' | 'NO ENCONTRADO';
  numeroAutorizacion: string | null;
  fechaAutorizacion: string | null;
  ambiente: string | null;
  comprobante: string | null;
  mensajes: SriMessage[];
}

@Injectable()
export class SriService {
  private readonly logger = new Logger(SriService.name);
  private readonly receptionUrl: string;
  private readonly authorizationUrl: string;
  private readonly xmlParser: XMLParser;
  private readonly useMock: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.receptionUrl =
      this.configService.get<string>('sri.receptionUrl') || '';
    this.authorizationUrl =
      this.configService.get<string>('sri.authorizationUrl') || '';
    this.useMock = this.configService.get<boolean>('sri.useMock') === true;

    if (
      this.useMock &&
      this.configService.get<string>('app.nodeEnv') === 'production'
    ) {
      throw new Error('SRI_USE_MOCK no puede habilitarse en producción');
    }

    // Configurar parser XML para respuestas SOAP
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseTagValue: false,
      trimValues: true,
    });
  }

  /**
   * Enviar comprobante al servicio de recepción del SRI
   */
  async sendToReception(data: {
    claveAcceso: string;
    xml: string;
  }): Promise<SriReceptionResponse> {
    this.logger.log(
      `Enviando comprobante a recepción SRI: ${data.claveAcceso}`,
    );

    // Si está en modo desarrollo sin URL del SRI, usar mock
    if (this.useMock) {
      this.logger.warn(
        'Usando respuesta MOCK para recepción (modo desarrollo)',
      );
      return this.getMockReceptionResponse(data.claveAcceso);
    }

    if (!this.receptionUrl) {
      throw new SriTemporaryError(
        'No está configurada la URL de recepción del SRI',
        'SRI_RECEPTION_URL_MISSING',
      );
    }

    try {
      // Construir envelope SOAP para recepción
      const soapEnvelope = this.buildReceptionEnvelope(data.xml);

      this.logger.debug(`Enviando a: ${this.receptionUrl}`);

      // Enviar petición SOAP
      const response = await firstValueFrom(
        this.httpService.post(this.receptionUrl, soapEnvelope, {
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: '',
          },
          timeout: 60000, // 60 segundos
        }),
      );

      // Parsear respuesta SOAP
      const parsedResponse = this.parseReceptionResponse(response.data);

      this.logger.log(`Respuesta de recepción: ${parsedResponse.estado}`);

      return parsedResponse;
    } catch (error: unknown) {
      if (error instanceof SriDomainError) throw error;

      if (this.isTemporaryNetworkError(error)) {
        const code = this.getErrorCode(error) || 'SRI_NETWORK_ERROR';
        throw new SriTemporaryError(
          `Error temporal en recepción SRI (${code})`,
          code,
          { cause: error },
        );
      }

      // Intentar extraer error específico del SRI (SOAP Fault)
      const fault = this.extractSoapFault(error);
      if (fault) {
        this.logger.error(`SRI FAULT: ${fault}`);

        if (
          fault.includes('GenericJDBCException') ||
          fault.includes('Could not open connection')
        ) {
          throw new SriTemporaryError(
            'El servicio interno del SRI no está disponible',
            'SRI_INTERNAL_UNAVAILABLE',
          );
        }

        throw new SriDefinitiveRejectionError(
          `El SRI rechazó la solicitud: ${fault}`,
          'SRI_RECEPTION_FAULT',
        );
      }

      const message = this.getErrorMessage(error);
      this.logger.error(`Error al enviar a recepción SRI: ${message}`);
      throw new SriTemporaryError(
        `Error en servicio de recepción del SRI: ${message}`,
        'SRI_RECEPTION_ERROR',
        { cause: error },
      );
    }
  }

  /**
   * Consultar autorización de comprobante en el SRI
   */
  async checkAuthorization(
    claveAcceso: string,
  ): Promise<SriAuthorizationResponse> {
    this.logger.log(`Consultando autorización en SRI: ${claveAcceso}`);

    // Si está en modo desarrollo sin URL del SRI, usar mock
    if (this.useMock) {
      this.logger.warn(
        'Usando respuesta MOCK para autorización (modo desarrollo)',
      );
      return this.getMockAuthorizationResponse(claveAcceso);
    }

    if (!this.authorizationUrl) {
      throw new SriTemporaryError(
        'No está configurada la URL de autorización del SRI',
        'SRI_AUTHORIZATION_URL_MISSING',
      );
    }

    try {
      // Construir envelope SOAP para autorización
      const soapEnvelope = this.buildAuthorizationEnvelope(claveAcceso);

      this.logger.debug(`Consultando en: ${this.authorizationUrl}`);

      // Enviar petición SOAP
      const response = await firstValueFrom(
        this.httpService.post(this.authorizationUrl, soapEnvelope, {
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: '',
          },
          timeout: 60000, // 60 segundos
        }),
      );

      // Parsear respuesta SOAP
      const parsedResponse = this.parseAuthorizationResponse(response.data);

      this.logger.log(`Estado de autorización: ${parsedResponse.estado}`);

      return parsedResponse;
    } catch (error: unknown) {
      if (error instanceof SriDomainError) throw error;

      if (this.isTemporaryNetworkError(error)) {
        const code = this.getErrorCode(error) || 'SRI_NETWORK_ERROR';
        throw new SriTemporaryError(
          `Error temporal en autorización SRI (${code})`,
          code,
          { cause: error },
        );
      }

      // Intentar extraer error específico del SRI (SOAP Fault)
      const fault = this.extractSoapFault(error);
      if (fault) {
        this.logger.error(`SRI FAULT: ${fault}`);

        if (
          fault.includes('GenericJDBCException') ||
          fault.includes('Could not open connection')
        ) {
          throw new SriTemporaryError(
            'El servicio interno del SRI no está disponible',
            'SRI_INTERNAL_UNAVAILABLE',
          );
        }

        throw new SriDefinitiveRejectionError(
          `El SRI rechazó la consulta de autorización: ${fault}`,
          'SRI_AUTHORIZATION_FAULT',
        );
      }

      const message = this.getErrorMessage(error);
      this.logger.error(`Error al consultar autorización SRI: ${message}`);
      throw new SriTemporaryError(
        `Error en servicio de autorización del SRI: ${message}`,
        'SRI_AUTHORIZATION_ERROR',
        { cause: error },
      );
    }
  }

  /**
   * Construir envelope SOAP para recepción
   */
  private buildReceptionEnvelope(xml: string): string {
    this.logger.debug(
      `Preparando XML para recepción SRI (${Buffer.byteLength(xml, 'utf8')} bytes)`,
    );

    // El método validarComprobante del SRI recibe el comprobante como base64Binary.
    // Enviar XML plano en CDATA provoca errores de conversión (error 35).
    const xmlWithDeclaration = xml.trimStart().startsWith('<?xml')
      ? xml
      : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
    const xmlBase64 = Buffer.from(xmlWithDeclaration, 'utf8').toString(
      'base64',
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">
  <soap:Header/>
  <soap:Body>
    <ec:validarComprobante>
      <xml>${xmlBase64}</xml>
    </ec:validarComprobante>
  </soap:Body>
</soap:Envelope>`;
  }

  /**
   * Construir envelope SOAP para autorización
   */
  private buildAuthorizationEnvelope(claveAcceso: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
  <soap:Header/>
  <soap:Body>
    <ec:autorizacionComprobante>
      <claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>
    </ec:autorizacionComprobante>
  </soap:Body>
</soap:Envelope>`;
  }

  /**
   * Parsear respuesta de recepción
   */
  private parseReceptionResponse(soapResponse: string): any {
    try {
      const parsed = this.xmlParser.parse(soapResponse);

      // Navegar la estructura SOAP
      const soapBody =
        parsed['soap:Envelope']?.['soap:Body'] ||
        parsed['soapenv:Envelope']?.['soapenv:Body'] ||
        parsed.Envelope?.Body;

      if (!soapBody) {
        throw new Error('Respuesta SOAP inválida: no se encontró Body');
      }

      // Extraer respuesta de validación
      const validarResponse =
        soapBody['ns2:validarComprobanteResponse'] ||
        soapBody['ns1:validarComprobanteResponse'] ||
        soapBody.validarComprobanteResponse;

      if (!validarResponse) {
        throw new Error('Respuesta de validación no encontrada');
      }

      const respuesta = validarResponse.RespuestaRecepcionComprobante;

      if (!respuesta) {
        throw new Error('Estructura de respuesta inválida');
      }

      // Normalizar respuesta
      return {
        estado: respuesta.estado || 'DEVUELTA',
        comprobantes: this.normalizeComprobantes(respuesta.comprobantes),
      };
    } catch (error) {
      this.logger.error(
        `Error al parsear respuesta de recepción: ${error.message}`,
      );
      throw new Error(`Error al parsear respuesta del SRI: ${error.message}`);
    }
  }

  /**
   * Parsear respuesta de autorización
   */
  private parseAuthorizationResponse(
    soapResponse: string,
  ): SriAuthorizationResponse {
    try {
      const parsed = this.xmlParser.parse(soapResponse);

      // Navegar la estructura SOAP
      const soapBody =
        parsed['soap:Envelope']?.['soap:Body'] ||
        parsed['soapenv:Envelope']?.['soapenv:Body'] ||
        parsed.Envelope?.Body;

      if (!soapBody) {
        throw new Error('Respuesta SOAP inválida: no se encontró Body');
      }

      // Extraer respuesta de autorización
      const autorizacionResponse =
        soapBody['ns2:autorizacionComprobanteResponse'] ||
        soapBody['ns1:autorizacionComprobanteResponse'] ||
        soapBody.autorizacionComprobanteResponse;

      if (!autorizacionResponse) {
        throw new Error('Respuesta de autorización no encontrada');
      }

      const respuesta = autorizacionResponse.RespuestaAutorizacionComprobante;

      if (!respuesta) {
        throw new Error('Estructura de respuesta inválida');
      }

      // Obtener autorizaciones (puede ser array o objeto único)
      const autorizaciones = respuesta.autorizaciones?.autorizacion;
      let autorizacion;

      if (Array.isArray(autorizaciones)) {
        autorizacion = autorizaciones[0];
      } else {
        autorizacion = autorizaciones;
      }

      if (!autorizacion) {
        return {
          estado: 'NO ENCONTRADO',
          numeroAutorizacion: null,
          fechaAutorizacion: null,
          ambiente: null,
          comprobante: null,
          mensajes: [],
        };
      }

      // Normalizar respuesta
      return {
        estado: autorizacion.estado || 'NO AUTORIZADO',
        numeroAutorizacion: autorizacion.numeroAutorizacion || null,
        fechaAutorizacion: autorizacion.fechaAutorizacion || null,
        ambiente: autorizacion.ambiente || 'PRUEBAS',
        comprobante: autorizacion.comprobante || null,
        mensajes: this.normalizeMensajes(autorizacion.mensajes),
      };
    } catch (error) {
      this.logger.error(
        `Error al parsear respuesta de autorización: ${error.message}`,
      );
      throw new Error(`Error al parsear respuesta del SRI: ${error.message}`);
    }
  }

  /**
   * Normalizar estructura de comprobantes
   */
  private normalizeComprobantes(comprobantes: any): any[] {
    if (!comprobantes) {
      return [];
    }

    const comprobanteArray = Array.isArray(comprobantes.comprobante)
      ? comprobantes.comprobante
      : [comprobantes.comprobante];

    return comprobanteArray.map((comp: any) => ({
      claveAcceso: comp.claveAcceso,
      mensajes: this.normalizeMensajes(comp.mensajes),
    }));
  }

  /**
   * Normalizar mensajes del SRI
   */
  private normalizeMensajes(mensajes: any): any[] {
    if (!mensajes || !mensajes.mensaje) {
      return [];
    }

    const mensajeArray = Array.isArray(mensajes.mensaje)
      ? mensajes.mensaje
      : [mensajes.mensaje];

    return mensajeArray.map((msg: any) => ({
      identificador: msg.identificador || '',
      mensaje: msg.mensaje || '',
      informacionAdicional: msg.informacionAdicional || '',
      tipo: msg.tipo || 'ERROR',
    }));
  }

  /**
   * Extraer mensaje de error SOAP (faultstring) de la respuesta
   */
  private extractSoapFault(error: any): string | null {
    if (!error.response || !error.response.data) return null;

    const data = error.response.data;
    const dataStr =
      typeof data === 'object' ? JSON.stringify(data) : String(data);

    const faultMatch =
      dataStr.match(/<(\w+:)?faultstring>(.*?)<\/\1?faultstring>/) ||
      dataStr.match(/<faultstring>(.*?)<\/faultstring>/);

    return faultMatch ? faultMatch[2] || faultMatch[1] : null;
  }

  /**
   * Obtener respuesta mock para recepción (desarrollo)
   */
  private async getMockReceptionResponse(
    claveAcceso: string,
  ): Promise<SriReceptionResponse> {
    await this.simulateDelay(1000);

    return {
      estado: 'RECIBIDA',
      comprobantes: [
        {
          claveAcceso: claveAcceso,
          mensajes: [
            {
              identificador: '43',
              mensaje: 'COMPROBANTE RECIBIDO - MOCK',
              informacionAdicional: 'Modo desarrollo',
              tipo: 'INFORMACION',
            },
          ],
        },
      ],
    };
  }

  /**
   * Obtener respuesta mock para autorización (desarrollo)
   */
  private async getMockAuthorizationResponse(
    claveAcceso: string,
  ): Promise<SriAuthorizationResponse> {
    await this.simulateDelay(2000);

    const fechaAutorizacion = new Date().toISOString();

    return {
      estado: 'AUTORIZADO',
      numeroAutorizacion: claveAcceso,
      fechaAutorizacion,
      ambiente: 'PRUEBAS',
      comprobante: null,
      mensajes: [],
    };
  }

  /**
   * Simular delay para desarrollo
   */
  private async simulateDelay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isTemporaryNetworkError(error: unknown): boolean {
    const code = this.getErrorCode(error);
    const status =
      typeof error === 'object' && error !== null && 'response' in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;

    return (
      [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
      ].includes(code || '') ||
      status === 429 ||
      (typeof status === 'number' && status >= 500)
    );
  }

  private getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }

    return String((error as { code?: unknown }).code || '') || undefined;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Validar conectividad con el SRI
   */
  async checkConnectivity(): Promise<{
    reception: boolean;
    authorization: boolean;
    message: string;
  }> {
    this.logger.log('Verificando conectividad con el SRI...');

    const result = {
      reception: false,
      authorization: false,
      message: '',
    };

    // Verificar recepción
    try {
      if (this.receptionUrl && !this.useMock) {
        const response = await firstValueFrom(
          this.httpService.get(this.receptionUrl.replace('?wsdl', ''), {
            timeout: 5000,
          }),
        );
        result.reception = response.status === 200;
      } else {
        result.reception = true; // Mock disponible
        result.message += 'Recepción: Modo mock. ';
      }
    } catch (error) {
      this.logger.warn(`No se pudo conectar a recepción: ${error.message}`);
      result.message += `Recepción: ${error.message}. `;
    }

    // Verificar autorización
    try {
      if (this.authorizationUrl && !this.useMock) {
        const response = await firstValueFrom(
          this.httpService.get(this.authorizationUrl.replace('?wsdl', ''), {
            timeout: 5000,
          }),
        );
        result.authorization = response.status === 200;
      } else {
        result.authorization = true; // Mock disponible
        result.message += 'Autorización: Modo mock.';
      }
    } catch (error) {
      this.logger.warn(`No se pudo conectar a autorización: ${error.message}`);
      result.message += `Autorización: ${error.message}.`;
    }

    if (result.reception && result.authorization) {
      result.message = 'Conexión exitosa con servicios del SRI';
      this.logger.log('✅ Conectividad con SRI: OK');
    } else {
      this.logger.warn('⚠️ Problemas de conectividad con SRI');
    }

    return result;
  }
}
