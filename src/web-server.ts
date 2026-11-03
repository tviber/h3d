import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const port = Number(process.env.PORT ?? 4173);

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const target = resolve(WEB_ROOT, `.${pathname}`);
  if (!target.startsWith(`${WEB_ROOT}${sep}`) || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404).end('Not Found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(target).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`h3d viewer: http://127.0.0.1:${port}/`);
  console.log('serving static files only; simulation runs separately with npm run muscles');
});
