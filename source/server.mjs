import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const portArgument = process.argv[2];
const port = portArgument === undefined ? 4173 : Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a local port between 1024 and 65535.');
const paths = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/web/style.css', ['web/style.css', 'text/css; charset=utf-8']],
  ['/web/app.mjs', ['web/app.mjs', 'text/javascript; charset=utf-8']],
  ...['engine', 'schema', 'fit', 'catalog', 'services', 'recovery', 'architecture'].map((name) => ['/' + name + '.mjs', [name + '.mjs', 'text/javascript; charset=utf-8']]),
  ...Array.from({ length: 6 }, (_, i) => {
    const path = 'scenarios/P' + (i + 1) + '.json';
    return ['/' + path, [path, 'application/json; charset=utf-8']];
  }),
]);
createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const route = paths.get(req.url.split('?')[0]);
  if (!route || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(route ? 405 : 404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(route ? 'Method not allowed' : 'Not found');
    return;
  }
  try {
    const content = await readFile(new URL(route[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error(error);
    res.writeHead(500).end('Unable to read the requested asset.');
  }
}).listen(port, '127.0.0.1', () => console.log('StackSense Workbench is running at http://127.0.0.1:' + port));
