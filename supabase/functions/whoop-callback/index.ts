// whoop-callback — OAuth2 Login mit Whoop
// ohne ?code=  -> Weiterleitung zum Whoop-Login
// mit  ?code=  -> Code gegen Tokens tauschen, in whoop_tokens speichern

const WHOOP_HOST = 'https://api.prod.whoop.com';
const AUTH_URL   = WHOOP_HOST + '/oauth/oauth2/auth';
const TOKEN_URL  = WHOOP_HOST + '/oauth/oauth2/token';

// offline = Pflicht fuer Refresh-Token. Steht NICHT im Dashboard, nur hier.
const SCOPES = [
  'offline',
  'read:recovery',
  'read:sleep',
  'read:cycles',
  'read:workout',
  'read:body_measurement',
].join(' ');

const CLIENT_ID     = Deno.env.get('WHOOP_CLIENT_ID') || '';
const CLIENT_SECRET = Deno.env.get('WHOOP_CLIENT_SECRET') || '';
const REDIRECT_URI  = Deno.env.get('WHOOP_REDIRECT_URI') || '';
const STATE         = Deno.env.get('WHOOP_STATE') || 'matacic-whoop';
const SB_URL        = Deno.env.get('SUPABASE_URL') || '';
const SB_KEY        = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

function page(title: string, body: string, ok = true) {
  const col = ok ? '#60f0a0' : '#d63b3b';
  const html = '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>'
    + 'body{background:#f4f6f9;font-family:ui-monospace,monospace;padding:40px 20px;}'
    + '.box{max-width:520px;margin:0 auto;background:#13131a;border:1px solid #2a2a38;'
    + 'border-radius:14px;padding:28px;color:#e8e8f0;}'
    + 'h1{font-size:18px;color:' + col + ';margin:0 0 14px;}'
    + 'p{font-size:13px;line-height:1.7;margin:0 0 10px;}'
    + 'code{color:#5bc8f5;font-size:12px;word-break:break-all;}'
    + '</style></head><body><div class="box"><h1>' + title + '</h1>' + body + '</div></body></html>';
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  const url  = new URL(req.url);
  const code = url.searchParams.get('code');
  const err  = url.searchParams.get('error');

  if (err) {
    return page('Abgebrochen', '<p>Whoop meldet: <code>' + err + '</code></p>', false);
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return page('Secrets fehlen',
      '<p>WHOOP_CLIENT_ID / _SECRET / _REDIRECT_URI sind in den Edge-Function-'
      + 'Secrets nicht gesetzt.</p>', false);
  }

  // --- Schritt 1: kein Code -> zum Whoop-Login ---
  if (!code) {
    const auth = new URL(AUTH_URL);
    auth.searchParams.set('client_id', CLIENT_ID);
    auth.searchParams.set('redirect_uri', REDIRECT_URI);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', SCOPES);
    auth.searchParams.set('state', STATE);
    return Response.redirect(auth.toString(), 302);
  }

  // --- Schritt 2: Code gegen Tokens tauschen ---
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body,
  });
  const txt = await res.text();

  if (!res.ok) {
    return page('Token-Tausch fehlgeschlagen',
      '<p>HTTP ' + res.status + '</p><p><code>' + txt.slice(0, 400) + '</code></p>'
      + '<p>Pruefen: stimmt die Redirect-URI im Whoop-Dashboard zeichengenau?</p>', false);
  }

  let tok: any;
  try { tok = JSON.parse(txt); }
  catch (_e) {
    return page('Antwort unlesbar', '<p><code>' + txt.slice(0, 300) + '</code></p>', false);
  }

  if (!tok.refresh_token) {
    return page('Kein Refresh-Token',
      '<p>Whoop hat keinen Refresh-Token geliefert — der Scope <code>offline</code> '
      + 'wurde nicht akzeptiert.</p>', false);
  }

  const expires_at = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();

  const up = await fetch(SB_URL + '/rest/v1/whoop_tokens?on_conflict=id', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      authorization: 'Bearer ' + SB_KEY,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{
      id: 1,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: expires_at,
      updated_at: new Date().toISOString(),
    }]),
  });

  if (!up.ok) {
    return page('DB-Fehler', '<p><code>' + (await up.text()).slice(0, 300) + '</code></p>', false);
  }

  return page('Whoop verbunden',
    '<p>Access- und Refresh-Token sind gespeichert.</p>'
    + '<p>Naechster Schritt: <code>whoop-sync</code> aufrufen.</p>'
    + '<p>Dieses Fenster kann geschlossen werden.</p>');
});
