// Vercel serverless function backing the KRA widget grid's "view via proxy"
// fallback. Fetches a PUBLIC, no-login page server-side and strips the
// framing restrictions (X-Frame-Options / frame-ancestors CSP) that block it
// from loading in an <iframe>, so it can render on a KRA widget the same way
// pages that already allow framing do.
//
// Beyond just unblocking the initial page load, this also rewrites the page
// so navigating around it keeps working:
//   - <a href> / <form action> are rewritten to route back through this
//     proxy (resolved to an absolute URL first), so clicking a link loads
//     the next page through the proxy instead of navigating straight to the
//     real site and hitting the frame-block wall again.
//   - An injected script patches window.fetch and XMLHttpRequest so the
//     page's own AJAX calls get transparently routed through /api/proxy?raw=1
//     too. The browser sees these as same-origin requests (since the URL now
//     points back at us), which sidesteps the CORS block that would
//     otherwise kill any dynamic feature relying on the site's own API.
//
// This is a best-effort HTML rewrite, not a full browser -- client-side
// routing that a single-page app drives via history.pushState/location
// assignment (rather than a real <a> click or <form> submit) isn't caught,
// so heavy JS-app dashboards will still only partially work. Static/mostly-
// server-rendered reference pages are the sweet spot.
//
// Deliberately does NOT forward cookies or any auth — this only makes sense
// for public/reference pages. Routing a login session through a third-party
// proxy is the same mechanism phishing proxies use, so that's out of scope
// by design, not an oversight.

const net = require('net');
const dns = require('dns').promises;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.split(':').pop();
      if (net.isIPv4(mapped)) return isPrivateIp(mapped);
    }
    return false;
  }
  return true; // unrecognized format — block rather than risk it
}

// Vercel's Node runtime already parses common body types into req.body; a
// plain http.IncomingMessage (used by local test servers) has not, so fall
// back to reading the raw stream ourselves.
async function readRequestBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') return req.body;
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks);
}

// Every rewritten URL must be ABSOLUTE and point at this proxy's own real
// origin -- not a root-relative path. A <base href="https://the-real-site">
// tag is present on the page (see below), and per spec that base applies to
// EVERY relative URL on the page, including ones this proxy injects. A path
// like "/api/proxy?url=..." would silently resolve against the real site's
// origin instead of ours and 404 there, not here.
function proxiedUrl(selfOrigin, absoluteUrl, { raw } = {}) {
  return `${selfOrigin}/api/proxy?${raw ? 'raw=1&' : ''}url=${encodeURIComponent(absoluteUrl)}`;
}

// Rewrite an <a href="..."> / <form action="..."> value to route through
// this proxy, resolved against the page's own URL first so relative links
// still land on the right page. Returns null for values that shouldn't be
// touched (anchors, javascript:, mailto:, etc).
function resolveToProxyPath(rawValue, pageUrl, selfOrigin) {
  const trimmed = rawValue.trim();
  if (!trimmed || /^(javascript:|mailto:|tel:|data:|#)/i.test(trimmed)) return null;
  try {
    const abs = new URL(trimmed, pageUrl).toString();
    return proxiedUrl(selfOrigin, abs);
  } catch (err) {
    return null;
  }
}

function rewriteNavigationAttrs(html, pageUrl, selfOrigin) {
  html = html.replace(/(<a\b[^>]*?\shref\s*=\s*)(["'])(.*?)\2/gi, (match, prefix, quote, value) => {
    const proxied = resolveToProxyPath(value, pageUrl, selfOrigin);
    return proxied ? `${prefix}${quote}${proxied}${quote}` : match;
  });
  html = html.replace(/(<form\b[^>]*?\saction\s*=\s*)(["'])(.*?)\2/gi, (match, prefix, quote, value) => {
    const proxied = resolveToProxyPath(value, pageUrl, selfOrigin);
    return proxied ? `${prefix}${quote}${proxied}${quote}` : match;
  });
  return html;
}

// Injected as the very first thing in <head>, before any of the page's own
// scripts run, so its fetch/XHR calls are already being intercepted by the
// time they're issued.
function buildInterceptScript(pageOrigin, selfOrigin) {
  return `<script>(function(){
var ORIGIN=${JSON.stringify(pageOrigin)};
var SELF=${JSON.stringify(selfOrigin)};
function toProxied(u){
  try{
    var abs=new URL(u,ORIGIN+'/').toString();
    return SELF+'/api/proxy?raw=1&url='+encodeURIComponent(abs);
  }catch(e){ return u; }
}
var origFetch=window.fetch;
if(origFetch){
  window.fetch=function(input,init){
    try{
      if(typeof input==='string'){
        if(input.indexOf(SELF+'/api/proxy')!==0) input=toProxied(input);
      }else if(input&&typeof input.url==='string'){
        if(input.url.indexOf(SELF+'/api/proxy')!==0) input=new Request(toProxied(input.url),input);
      }
    }catch(e){}
    return origFetch.call(this,input,init);
  };
}
var origOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
  try{
    if(url!==undefined&&url!==null&&String(url).indexOf(SELF+'/api/proxy')!==0){
      arguments[1]=toProxied(String(url));
    }
  }catch(e){}
  return origOpen.apply(this,arguments);
};
})();</script>`;
}

module.exports = async (req, res) => {
  const target = req.query && req.query.url;
  const raw = Boolean(req.query && (req.query.raw === '1' || req.query.raw === 'true'));

  const reqHost = req.headers && req.headers.host;
  const forwardedProto = req.headers && req.headers['x-forwarded-proto'];
  const selfProto = forwardedProto
    ? String(forwardedProto).split(',')[0].trim()
    : reqHost && /localhost|127\.0\.0\.1/.test(reqHost)
    ? 'http'
    : 'https';
  const selfOrigin = reqHost ? `${selfProto}://${reqHost}` : '';

  if (!target || typeof target !== 'string') {
    res.status(400).send('Missing "url" query parameter');
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (err) {
    res.status(400).send('That is not a valid URL');
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).send('Only http/https URLs are supported');
    return;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    res.status(400).send('That host is not allowed');
    return;
  }

  // SSRF guard: resolve the hostname and refuse to fetch anything that
  // points at internal/private network space. A "fetch any URL for me"
  // endpoint is a classic way to probe a host's internal infrastructure
  // if this check isn't here. Runs for every request, including the
  // raw AJAX passthrough and rewritten link/form navigations.
  try {
    const resolved = await dns.lookup(hostname);
    if (isPrivateIp(resolved.address)) {
      res.status(400).send('That host is not allowed');
      return;
    }
  } catch (err) {
    res.status(400).send('Could not resolve that host');
    return;
  }

  const method = (req.method || 'GET').toUpperCase();
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readRequestBody(req);
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
    }
  }

  const upstreamHeaders = {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept':
      (req.headers && req.headers.accept) ||
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (req.headers && req.headers['content-type']) {
    upstreamHeaders['Content-Type'] = req.headers['content-type'];
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      method,
      headers: upstreamHeaders,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    res.status(502).send('Could not reach that site (it may be down, or blocking automated requests).');
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isHtml = contentType.includes('text/html');

  if (raw || !isHtml) {
    // Either the page's own JS asked for this (raw=1, so it's whatever
    // content type its API returns), or it's a non-HTML resource fetched
    // directly through the proxy — only top-level HTML documents carry
    // frame restrictions and need rewriting.
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(upstream.status).send(buf);
    return;
  }

  let html = await upstream.text();

  const basePath = parsed.pathname.replace(/\/[^/]*$/, '/') || '/';
  const pageOrigin = `${parsed.protocol}//${parsed.host}`;
  const baseHref = `${pageOrigin}${basePath}`;

  // A <base> tag makes the browser resolve every relative link/asset
  // against the ORIGINAL site instead of this proxy, without needing to
  // rewrite every plain resource URL (img/script/link) by hand. The
  // fetch/XHR intercept script is injected right alongside it, so it's in
  // place before any of the page's own scripts execute.
  const headInjection = `<base href="${baseHref}">${buildInterceptScript(pageOrigin, selfOrigin)}`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}${headInjection}`);
  } else {
    html = `<head>${headInjection}</head>${html}`;
  }

  // Some sites set their frame-blocking policy via a <meta> tag rather than
  // (or in addition to) the HTTP header — strip that too, since dropping
  // just the header wouldn't be enough on its own for those pages.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  // Keep normal navigation (clicking a link, submitting a form) routed
  // through the proxy instead of jumping straight to the real site, which
  // would immediately hit the frame-block again.
  html = rewriteNavigationAttrs(html, parsed, selfOrigin);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // Deliberately not setting X-Frame-Options or a frame-restrictive CSP —
  // that omission is the entire point of this endpoint.
  res.status(200).send(html);
};
