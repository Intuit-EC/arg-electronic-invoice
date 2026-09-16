import * as dns from 'node:dns';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import * as ipaddr from 'ipaddr.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function parseAndValidateCallbackUrl(
  rawUrl: string,
  production: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('callbackUrl no es una URL válida');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error('callbackUrl debe usar HTTP o HTTPS');
  }
  if (production && url.protocol !== 'https:') {
    throw new Error('callbackUrl debe usar HTTPS en producción');
  }
  if (url.username || url.password) {
    throw new Error('callbackUrl no puede contener credenciales');
  }
  if (!url.hostname) {
    throw new Error('callbackUrl debe contener un hostname');
  }

  return url;
}

export async function assertPublicCallbackDestination(url: URL): Promise<void> {
  const addresses = await dns.promises.lookup(url.hostname, {
    all: true,
    verbatim: true,
  });

  if (!addresses.length) {
    throw new Error('callbackUrl no pudo resolverse por DNS');
  }

  addresses.forEach(({ address }) => assertPublicIp(address));
}

export function createValidatedHttpsAgent(): https.Agent {
  const lookup: LookupFunction = ((
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    dns.lookup(
      hostname,
      { ...options, all: true, verbatim: true },
      (error, addresses) => {
        if (error) {
          callback(error, '');
          return;
        }

        try {
          addresses.forEach(({ address }) => assertPublicIp(address));
          if (!addresses.length)
            throw new Error('El hostname no resolvió direcciones');

          if ('all' in options && options.all) {
            callback(null, addresses);
          } else {
            callback(null, addresses[0].address, addresses[0].family);
          }
        } catch (validationError) {
          const errorToReturn = new Error(
            validationError instanceof Error
              ? validationError.message
              : String(validationError),
          ) as NodeJS.ErrnoException;
          errorToReturn.code = 'ESSRF';
          callback(errorToReturn, '');
        }
      },
    );
  }) as LookupFunction;

  return new https.Agent({ keepAlive: true, lookup });
}

function assertPublicIp(address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new Error('callbackUrl resolvió una dirección IP inválida');
  }

  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
  }

  if (parsed.range() !== 'unicast') {
    throw new Error(
      `callbackUrl resolvió una dirección no pública (${parsed.range()})`,
    );
  }
}
