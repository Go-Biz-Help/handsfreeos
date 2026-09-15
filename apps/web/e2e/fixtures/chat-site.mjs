/**
 * A stand-in business website for the website chat specs: `node e2e/fixtures/chat-site.mjs <port>`. Playwright
 * serves one on 127.0.0.1:4191 (a site the widget allows) and one on 127.0.0.1:4192 (a site it doesn't). They're on
 * 127.0.0.1, a different site from the app's localhost, so the chat window runs as a third party, as on a real site.
 *
 * Every page pastes the snippet it's given (?snippet=) before </body>, exactly as a business would. Only our own
 * snippet's shape is accepted, so a link can't make the page run anything else. Any path works
 * (/services/ac-tune-up), and the page is long enough to scroll.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.PORT ?? 4191);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error(`Invalid port: ${process.argv[2] ?? process.env.PORT}`);

const SNIPPET =
  /^<script async src="http:\/\/localhost:3000\/embed\/v1\/wk_[A-Za-z0-9]{20}\.js(\?[^"<>]*)?"><\/script>$/;

const section = (title, text) => `<section><h2>${title}</h2><p>${text}</p></section>`;

const page = (snippet) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lone Star HVAC &amp; Roofing</title>
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d232c;background:#fff}
header{display:flex;flex-wrap:wrap;gap:20px;align-items:center;padding:18px 24px;border-bottom:1px solid #eceef2}
header a{color:inherit}
nav{display:flex;gap:16px}
.hero{padding:48px 24px;background:#b42318;color:#fff}
main{padding:24px;max-width:760px}
section{padding:16px 0;border-bottom:1px solid #eceef2}
</style>
</head>
<body>
<header><a href="/">Lone Star HVAC &amp; Roofing</a><nav><a href="/services/ac-tune-up">Services</a><a href="/about">About</a><a href="/contact">Contact</a></nav></header>
<div class="hero"><h1>Keep your AC running all summer</h1><p>A full tune-up in about an hour. From $89.</p></div>
<main>
${section('What’s included', 'Coils, refrigerant, electrical parts, thermostat, filter and drain line, checked and cleaned.')}
${section('Maintenance plan', 'Two tune-ups a year, priority visits and 15% off repairs.')}
${section('Where we work', 'Houston, Katy, Sugar Land, Pearland, The Woodlands, Cypress and Spring.')}
${section('Roofing', 'Inspections, repairs and full replacements, with a written estimate first.')}
${section('Financing', 'Spread the cost of a new system over 12 to 60 months.')}
${section('Reviews', 'Rated 4.9 by more than 800 Houston homeowners.')}
${section('About us', 'Family owned since 1998. Licensed and insured.')}
${section('Contact', 'Call (713) 555-0100, or use the chat button.')}
</main>
${snippet}
</body>
</html>
`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const snippet = url.searchParams.get('snippet') ?? '';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page(SNIPPET.test(snippet) ? snippet : ''));
}).listen(port, '127.0.0.1', () => {
  console.log(`Chat test site at http://127.0.0.1:${port}`);
});
