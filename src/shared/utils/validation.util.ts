import { FIELD_LENGTHS } from '../constants/sri.constants';

/**
 * Valida el formato de un RUC ecuatoriano (13 dígitos, tercer dígito y
 * establecimiento válidos). No valida el dígito verificador: el SRI tiene
 * RUC reales y activos (históricos/reasignados) que no satisfacen el
 * checksum módulo-11 estándar, y ese checksum rechazaba RUC válidos.
 */
export function validateRuc(ruc: string): boolean {
  if (!ruc || ruc.length !== FIELD_LENGTHS.RUC || !/^\d{13}$/.test(ruc)) {
    return false;
  }

  const tercerDigito = parseInt(ruc.charAt(2));
  if (tercerDigito > 6 && tercerDigito !== 9) {
    return false;
  }

  const establecimiento = parseInt(ruc.substring(10, 13));
  return establecimiento >= 1;
}

/**
 * Valida una cédula ecuatoriana
 */
export function validateCedula(cedula: string): boolean {
  if (!cedula || cedula.length !== FIELD_LENGTHS.CEDULA) {
    return false;
  }

  const provincia = parseInt(cedula.substring(0, 2));
  if (provincia < 1 || provincia > 24) {
    return false;
  }

  const coeficientes = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;

  for (let i = 0; i < 9; i++) {
    let valor = parseInt(cedula.charAt(i)) * coeficientes[i];
    if (valor >= 10) {
      valor -= 9;
    }
    suma += valor;
  }

  const digitoVerificador = parseInt(cedula.charAt(9));
  const resultado = suma % 10;
  const verificador = resultado === 0 ? 0 : 10 - resultado;

  return verificador === digitoVerificador;
}
