// ============================================================
//  withings-callback
//  ------------------------------------------------------------
//  Zwei Aufgaben in einer Function:
//
//  1) Aufruf OHNE ?code=...  -> leitet zu Withings weiter (Login)
//  2) Aufruf MIT  ?code=...  -> Withings schickt dich zurueck,
//                               wir tauschen den Code gegen Tokens
//                               und legen sie in der DB ab.
//
//  Verify JWT muss AUS sein: Withings kennt keine Supabase-Logins.
//  Der Schutz laeuft ueber den state-Parameter.
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const WITHINGS_AUTHORIZE = "https://account.withings.com/oauth2_user/authorize2";
const WITHINGS_TOKEN = "https://wbsapi.withings.net/v2/oauth2";

// ------------------------------------------------------------
// Supabase-Schluessel ermitteln.
// Supabase stellt gerade um: alt = SUPABASE_SERVICE_ROLE_KEY,
// neu = SUPABASE_SECRET_KEYS (JSON). Wir akzeptieren beides.
// ------------------------------------------------------------
function resolveServiceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy && legacy.length > 0) return legacy;

  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) throw new Error("Kein Service-Key gefunden (weder alt noch neu).");

  try {
    const parsed = JSON.parse(raw);

    if (typeof parsed === "string") return parsed;

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string") return entry;
        const v = entry?.api_key ?? entry?.key ?? entry?.secret ?? entry?.value;
        if (typeof v === "string") return v;
      }
    }

    if (parsed && typeof parsed === "object") {
      for (const v of Object.values(parsed)) {
        if (typeof v === "string" && v.length > 0) return v;
        const nested = (v as Record<string, unknown>)?.api_key
          ?? (v as Record<string, unknown>)?.key
          ?? (v as Record<string, unknown>)?.value;
        if (typeof nested === "string") return nested;
      }
    }
  } catch (_e) {
    // SUPABASE_SECRET_KEYS war kein JSON -> vielleicht direkt der Key
    if (raw.startsWith("sb_secret_") || raw.startsWith("ey")) return raw;
  }

  throw new Error("Service-Key konnte nicht aus SUPABASE_SECRET_KEYS gelesen werden.");
}

// ------------------------------------------------------------
// Kleine HTML-Antwort, damit du im Browser siehst was los ist
// ------------------------------------------------------------
function page(title: string, message: string, ok: boolean): Response {
  const color = ok ? "#60f0a0" : "#d63b3b";
  const html = `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { background:#0d0d0f; color:#e8e8ea; font-family:ui-monospace,Menlo,monospace;
         display:flex; align-items:center; justify-content:center;
         min-height:100vh; margin:0; padding:24px; }
  .card { max-width:520px; text-align:center; border:1px solid #2a2a30;
          border-radius:14px; padding:32px; background:#141418; }
  h1 { color:${color}; font-size:1.2rem; letter-spacing:.08em; text-transform:uppercase; }
  p { color:#9a9aa2; line-height:1.6; font-size:.9rem; }
  a { color:#1a7fc4; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;

  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ------------------------------------------------------------
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    const clientId = Deno.env.get("WITHINGS_CLIENT_ID");
    const clientSecret = Deno.env.get("WITHINGS_CLIENT_SECRET");
    const redirectUri = Deno.env.get("WITHINGS_REDIRECT_URI");
    const expectedState = Deno.env.get("WITHINGS_STATE");

    if (!clientId || !clientSecret || !redirectUri || !expectedState) {
      return page("Konfiguration unvollstaendig",
        "Mindestens eines der WITHINGS_* Secrets fehlt in den Edge Function Secrets.", false);
    }

    // --- Withings hat den Login abgelehnt / abgebrochen ---
    if (error) {
      return page("Abgebrochen", `Withings meldet: ${error}`, false);
    }

    // ========================================================
    // FALL 1: Kein Code -> Login starten
    // ========================================================
    if (!code) {
      const authUrl = new URL(WITHINGS_AUTHORIZE);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("scope", "user.metrics");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("state", expectedState);

      return Response.redirect(authUrl.toString(), 302);
    }

    // ========================================================
    // FALL 2: Code da -> gegen Tokens tauschen
    // ========================================================

    // Schutz: kommt der Rueckruf wirklich von unserem Login?
    if (state !== expectedState) {
      return page("Ungueltiger state",
        "Der zurueckgegebene state stimmt nicht. Anfrage abgewiesen.", false);
    }

    const form = new URLSearchParams({
      action: "requesttoken",
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      redirect_uri: redirectUri,
    });

    const res = await fetch(WITHINGS_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const json = await res.json();

    // Withings antwortet IMMER mit HTTP 200 -- der echte Status
    // steckt im Feld "status" (0 = alles gut).
    if (json.status !== 0) {
      console.error("Withings Token-Fehler:", JSON.stringify(json));
      return page("Token-Tausch fehlgeschlagen",
        `Withings status ${json.status}: ${json.error ?? "unbekannt"}`, false);
    }

    const body = json.body;
    const expiresAt = new Date(Date.now() + (body.expires_in ?? 10800) * 1000);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      resolveServiceKey(),
      { auth: { persistSession: false } },
    );

    const { error: dbError } = await supabase
      .from("withings_tokens")
      .upsert({
        id: 1,
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      });

    if (dbError) {
      console.error("DB-Fehler:", dbError);
      return page("Speichern fehlgeschlagen", dbError.message, false);
    }

    return page("Verbunden",
      "Withings ist jetzt mit deinem Dashboard verbunden. Du kannst dieses Fenster schliessen.",
      true);

  } catch (e) {
    console.error("Unerwarteter Fehler:", e);
    return page("Fehler", String(e), false);
  }
});
