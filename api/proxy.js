// Vercel serverless function backing the KRA widget grid's "view via proxy"
// fallback. Fetches a PUBLIC, no-login page server-side and strips the
// framing restrictions (X-Frame-Options / frame-ancestors CSP) that block it
// from loading in an <iframe>, so it can render on a KRA widget the same way
// pages that already allow framing do.
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

module.exports = async (req, res) => {
  const target = req.query && req.query.url;
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
  // if this check isn't here.
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

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    res.status(502).send('Could not reach that site (it may be down, or blocking automated requests).');
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';

  if (!contentType.includes('text/html')) {
    // Non-HTML resource requested directly through the proxy — pass it
    // through unmodified; only top-level documents carry frame restrictions.
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.status(upstream.status).send(buf);
    return;
  }

  let html = await upstream.text();

  // A <base> tag makes the browser resolve every relative link/asset/form
  // against the ORIGINAL site instead of this proxy, without needing to
  // rewrite every URL in the document by hand.
  const basePath = parsed.pathname.replace(/\/[^/]*$/, '/') || '/';
  const baseHref = `${parsed.protocol}//${parsed.host}${basePath}`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}<base href="${baseHref}">`);
  } else {
    html = `<head><base href="${baseHref}"></head>${html}`;
  }

  // Some sites set their frame-blocking policy via a <meta> tag rather than
  // (or in addition to) the HTTP header — strip that too, since dropping
  // just the header wouldn't be enough on its own for those pages.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // Deliberately not setting X-Frame-Options or a frame-restrictive CSP —
  // that omission is the entire point of this endpoint.
  res.status(200).send(html);
};
