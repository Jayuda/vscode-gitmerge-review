import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function httpRequest(urlStr: string, options: RequestOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'vscode-gitmerge/1.0',
        ...(options.headers ?? {}),
        ...(options.body
          ? { 'Content-Length': Buffer.byteLength(options.body) }
          : {}),
      },
    };

    const req = transport.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${status}: ${data.slice(0, 300)}`));
        }
      });
    });

    req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${urlStr}`));
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function basicHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}` };
}
