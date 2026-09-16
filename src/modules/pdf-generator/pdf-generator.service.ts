import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import * as handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import JsBarcode from 'jsbarcode';
import { createCanvas } from 'canvas';

@Injectable()
export class PdfGeneratorService {
  private readonly logger = new Logger(PdfGeneratorService.name);
  private template: handlebars.TemplateDelegate;

  constructor() {
    this.registerHelpers();
    this.loadTemplate();
  }

  private registerHelpers() {
    handlebars.registerHelper('eq', function (arg1, arg2) {
      return arg1 == arg2;
    });
  }

  private loadTemplate() {
    try {
      const templatePath = path.join(
        __dirname,
        'templates',
        'ride-template.hbs',
      );
      const templateSource = fs.readFileSync(templatePath, 'utf8');
      this.template = handlebars.compile(templateSource);
    } catch (error) {
      this.logger.error('Error loading RIDE template', error.stack);
    }
  }

  private generateBarcodeBase64(text: string): string {
    try {
      const canvas = createCanvas(300, 100);
      JsBarcode(canvas, text, {
        format: 'CODE128',
        displayValue: true,
        fontSize: 14,
        margin: 10,
        height: 60,
      });
      return canvas.toDataURL('image/png');
    } catch (e) {
      this.logger.error('Error generating barcode', e);
      return '';
    }
  }

  async generateRideFromXml(
    xmlContent: string,
    authData?: { numeroAutorizacion?: string; fechaAutorizacion?: Date },
  ): Promise<Buffer> {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseAttributeValue: true,
      });

      // Si el XML es la respuesta de autorización completa, el documento de la factura estará dentro de comprobante
      const parsedXml = parser.parse(xmlContent);

      let invoiceData;
      let numeroAutorizacion = authData?.numeroAutorizacion || '';
      let fechaAutorizacion = authData?.fechaAutorizacion
        ? authData.fechaAutorizacion.toLocaleString('es-EC')
        : '';

      if (parsedXml.autorizacion && parsedXml.autorizacion.comprobante) {
        // Es un XML de autorización del SRI
        const comprobanteXml = parsedXml.autorizacion.comprobante;
        const parsedComprobante = parser.parse(comprobanteXml);
        invoiceData =
          parsedComprobante.factura ||
          parsedComprobante.notaCredito ||
          parsedComprobante.notaDebito ||
          parsedComprobante.guiaRemision ||
          parsedComprobante.comprobanteRetencion;

        numeroAutorizacion = parsedXml.autorizacion.numeroAutorizacion;
        fechaAutorizacion = parsedXml.autorizacion.fechaAutorizacion;
      } else if (parsedXml.factura) {
        // Es un XML firmado directamente
        invoiceData = parsedXml.factura;
      } else {
        throw new Error('Formato XML no reconocido o no soportado');
      }

      // Preprocesamiento de subtotales dinámicos
      const subtotales = {
        subtotal15: '0.00',
        subtotal12: '0.00',
        subtotal0: '0.00',
        subtotalNoObjeto: '0.00',
        subtotalExento: '0.00',
        iva15: '0.00',
        iva12: '0.00',
      };

      const impuestos =
        invoiceData.infoFactura?.totalConImpuestos?.totalImpuesto;
      const impuestosArray = Array.isArray(impuestos)
        ? impuestos
        : impuestos
          ? [impuestos]
          : [];

      for (const imp of impuestosArray) {
        if (imp.codigo == '2' || imp.codigo == 2) {
          if (imp.codigoPorcentaje == '0' || imp.codigoPorcentaje == 0)
            subtotales.subtotal0 = Number(imp.baseImponible).toFixed(2);
          if (imp.codigoPorcentaje == '2' || imp.codigoPorcentaje == 2) {
            subtotales.subtotal12 = Number(imp.baseImponible).toFixed(2);
            subtotales.iva12 = Number(imp.valor).toFixed(2);
          }
          if (imp.codigoPorcentaje == '4' || imp.codigoPorcentaje == 4) {
            subtotales.subtotal15 = Number(imp.baseImponible).toFixed(2);
            subtotales.iva15 = Number(imp.valor).toFixed(2);
          }
          if (imp.codigoPorcentaje == '6' || imp.codigoPorcentaje == 6)
            subtotales.subtotalNoObjeto = Number(imp.baseImponible).toFixed(2);
          if (imp.codigoPorcentaje == '7' || imp.codigoPorcentaje == 7)
            subtotales.subtotalExento = Number(imp.baseImponible).toFixed(2);
        }
      }

      // Código de barras de clave de acceso
      const barcodeImage = invoiceData.infoTributaria?.claveAcceso
        ? this.generateBarcodeBase64(invoiceData.infoTributaria.claveAcceso)
        : null;

      const templateData = {
        ...invoiceData,
        numeroAutorizacion,
        fechaAutorizacion,
        subtotales,
        barcodeImage,
      };

      // Si detalles.detalle es un objeto en lugar de un array, lo convertimos a array para el helper #each
      if (
        templateData.detalles &&
        templateData.detalles.detalle &&
        !Array.isArray(templateData.detalles.detalle)
      ) {
        templateData.detalles.detalle = [templateData.detalles.detalle];
      }

      if (
        templateData.infoAdicional &&
        templateData.infoAdicional.campoAdicional &&
        !Array.isArray(templateData.infoAdicional.campoAdicional)
      ) {
        templateData.infoAdicional.campoAdicional = [
          templateData.infoAdicional.campoAdicional,
        ];
      }

      const html = this.template(templateData);

      const browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // Útil para Docker (evita crash por memoria)
        ],
      });
      const page = await browser.newPage();

      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
      });

      await browser.close();

      return Buffer.from(pdfBuffer);
    } catch (error) {
      this.logger.error('Error generating PDF from XML', error.stack);
      throw error;
    }
  }
}
