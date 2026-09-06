import { getAvatarByKey, getAvatarEntries } from "./avatars.js";

const SESSION_COOKIE = "session";
const OAUTH_STATE_COOKIE = "oauth_state";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/") {
        return await handleHome(request, env);
      }

      if (request.method === "GET" && path === "/login") {
        return await handleLogin(request, env);
      }

      if (request.method === "GET" && path === "/callback") {
        return await handleCallback(request, env);
      }

      if (request.method === "POST" && path === "/select") {
        return await handleSelect(request, env);
      }

      if (request.method === "POST" && path === "/logout") {
        return handleLogout(request);
      }

      if (request.method === "GET" && path === "/css") {
        return await handleCss(env);
      }

      if (request.method === "GET" && path === "/admin") {
        return await handleAdmin(request, env);
      }

      if (request.method === "POST" && path === "/admin/remove") {
        return await handleAdminRemove(request, env);
      }

      if (request.method === "POST" && path === "/admin/reset") {
        return await handleAdminReset(request, env);
      }

      return textResponse("Not Found", 404);
    } catch (error) {
      console.error("Unhandled worker error", error);
      return textResponse("Internal server error", 500);
    }
  }
};

async function handleHome(request, env) {
  const session = await getSessionFromRequest(request, env);
  const avatars = getAvatarEntries();
  let currentAvatarKey = null;

  if (session) {
    try {
      const row = await env.DB.prepare(
        "SELECT avatar_key FROM selections WHERE discord_id = ?"
      )
        .bind(session.discordId)
        .first();
      currentAvatarKey = row?.avatar_key ?? null;
    } catch (error) {
      console.error("Failed to load user selection", error);
    }
  }

  const html = renderHomeHtml({
    user: session,
    avatars,
    currentAvatarKey
  });

  return htmlResponse(html);
}

async function handleLogin(request, env) {
  assertRequiredEnv(env);
  const secureCookie = shouldUseSecureCookie(request);

  const state = await createOpaqueToken();
  const stateCookie = serializeCookie(OAUTH_STATE_COOKIE, state, {
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    httpOnly: true,
    secure: secureCookie,
    sameSite: "Lax"
  });

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": stateCookie
    }
  });
}

async function handleCallback(request, env) {
  assertRequiredEnv(env);
  const secureCookie = shouldUseSecureCookie(request);

  const callbackUrl = new URL(request.url);
  const code = callbackUrl.searchParams.get("code");
  const state = callbackUrl.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const savedState = cookies[OAUTH_STATE_COOKIE];

  if (!code || !state || !savedState || state !== savedState) {
    return textResponse("Invalid OAuth state", 400);
  }

  let accessToken;
  try {
    accessToken = await exchangeDiscordCode(env, code);
  } catch (error) {
    console.error("Discord token exchange failed", error);
    return textResponse("Discord authentication failed", 400);
  }

  let identity;
  try {
    identity = await fetchDiscordIdentity(accessToken);
  } catch (error) {
    console.error("Discord /users/@me failed", error);
    return textResponse("Could not load Discord identity", 400);
  }

  const sessionPayload = {
    discordId: String(identity.id),
    username: String(identity.username || ""),
    globalName: identity.global_name ? String(identity.global_name) : "",
    iat: Date.now()
  };

  const sessionCookie = await createSessionCookie(sessionPayload, env.SESSION_SECRET, secureCookie);
  const clearStateCookie = serializeCookie(OAUTH_STATE_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    secure: secureCookie,
    sameSite: "Lax"
  });

  const headers = new Headers();
  headers.set("Location", "/");
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", clearStateCookie);

  return new Response(null, {
    status: 302,
    headers
  });
}

async function handleSelect(request, env) {
  const user = await requireAuth(request, env);
  if (!user) {
    return textResponse("Unauthorized", 401);
  }

  const contentType = request.headers.get("content-type") || "";
  let avatarKey = "";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    avatarKey = String(body.avatarKey || "").trim();
  } else {
    const form = await request.formData();
    avatarKey = String(form.get("avatarKey") || "").trim();
  }

  if (!avatarKey || !getAvatarByKey(avatarKey)) {
    return textResponse("Invalid avatar", 400);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO selections (discord_id, username, global_name, avatar_key)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET
         username = excluded.username,
         global_name = excluded.global_name,
         avatar_key = excluded.avatar_key,
         updated_at = CURRENT_TIMESTAMP`
    )
      .bind(user.discordId, user.username, user.globalName || null, avatarKey)
      .run();
  } catch (error) {
    console.error("Failed to persist selection", error);
    return textResponse("Failed to save selection", 500);
  }

  return redirectTo("/");
}

function handleLogout(request) {
  const secureCookie = shouldUseSecureCookie(request);
  const clearSessionCookie = serializeCookie(SESSION_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    secure: secureCookie,
    sameSite: "Lax"
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": clearSessionCookie
    }
  });
}

async function handleCss(env) {
  let rows;
  try {
    const result = await env.DB.prepare(
      "SELECT discord_id, username, global_name, avatar_key FROM selections ORDER BY updated_at DESC"
    ).all();
    rows = result.results || [];
  } catch (error) {
    console.error("Failed loading CSS rows", error);
    return textResponse("Failed to generate CSS", 500);
  }

  const css = generateOverlayCss(rows);
  return new Response(css, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function handleAdmin(request, env) {
  const user = await requireAuth(request, env);
  if (!user) {
    return textResponse("Unauthorized", 401);
  }
  if (!isAdmin(user.discordId, env.ADMIN_DISCORD_IDS)) {
    return textResponse("Forbidden", 403);
  }

  let rows;
  try {
    const result = await env.DB.prepare(
      "SELECT discord_id, username, global_name, avatar_key, updated_at FROM selections ORDER BY updated_at DESC"
    ).all();
    rows = result.results || [];
  } catch (error) {
    console.error("Failed loading admin table", error);
    return textResponse("Failed to load admin data", 500);
  }

  const html = renderAdminHtml({ user, rows });
  return htmlResponse(html);
}

async function handleAdminRemove(request, env) {
  const user = await requireAuth(request, env);
  if (!user) {
    return textResponse("Unauthorized", 401);
  }
  if (!isAdmin(user.discordId, env.ADMIN_DISCORD_IDS)) {
    return textResponse("Forbidden", 403);
  }

  const form = await request.formData();
  const discordId = String(form.get("discordId") || "").trim();
  if (!discordId) {
    return textResponse("Missing discordId", 400);
  }

  try {
    await env.DB.prepare("DELETE FROM selections WHERE discord_id = ?").bind(discordId).run();
  } catch (error) {
    console.error("Failed removing row", error);
    return textResponse("Failed to remove assignment", 500);
  }

  return redirectTo("/admin");
}

async function handleAdminReset(request, env) {
  const user = await requireAuth(request, env);
  if (!user) {
    return textResponse("Unauthorized", 401);
  }
  if (!isAdmin(user.discordId, env.ADMIN_DISCORD_IDS)) {
    return textResponse("Forbidden", 403);
  }

  try {
    await env.DB.prepare("DELETE FROM selections").run();
  } catch (error) {
    console.error("Failed resetting assignments", error);
    return textResponse("Failed to reset assignments", 500);
  }

  return redirectTo("/admin");
}

function isAdmin(discordId, adminList) {
  const ids = String(adminList || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.includes(String(discordId));
}

async function requireAuth(request, env) {
  return await getSessionFromRequest(request, env);
}

async function getSessionFromRequest(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  try {
    const payload = await verifySignedToken(token, env.SESSION_SECRET);
    if (!payload || !payload.discordId || !payload.username) {
      return null;
    }
    return {
      discordId: String(payload.discordId),
      username: String(payload.username),
      globalName: payload.globalName ? String(payload.globalName) : ""
    };
  } catch (error) {
    console.error("Session verification failed", error);
    return null;
  }
}

async function createSessionCookie(payload, sessionSecret, secureCookie) {
  const token = await createSignedToken(payload, sessionSecret);
  return serializeCookie(SESSION_COOKIE, token, {
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    secure: secureCookie,
    sameSite: "Lax"
  });
}

async function createSignedToken(payload, secret) {
  const dataPart = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256Base64Url(dataPart, secret);
  return `${dataPart}.${signature}`;
}

async function verifySignedToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed token");
  }

  const [dataPart, signature] = parts;
  const expected = await hmacSha256Base64Url(dataPart, secret);
  if (!safeCompare(signature, expected)) {
    throw new Error("Invalid signature");
  }

  const raw = base64UrlDecode(dataPart);
  return JSON.parse(raw);
}

async function hmacSha256Base64Url(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

function safeCompare(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function base64UrlEncode(input) {
  const bytes = new TextEncoder().encode(input);
  return bytesToBase64Url(bytes);
}

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(valueParts.join("="));
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    segments.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    segments.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`);
  }
  return segments.join("; ");
}

function redirectTo(pathname) {
  return new Response(null, {
    status: 302,
    headers: { Location: pathname }
  });
}

async function exchangeDiscordCode(env, code) {
  const body = new URLSearchParams();
  body.set("client_id", env.DISCORD_CLIENT_ID);
  body.set("client_secret", env.DISCORD_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", env.DISCORD_REDIRECT_URI);

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    const responseBody = await response.text();
    console.error("Discord token response error", response.status, responseBody);
    throw new Error("token exchange failed");
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error("No access token in Discord response");
  }

  return payload.access_token;
}

async function fetchDiscordIdentity(accessToken) {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const responseBody = await response.text();
    console.error("Discord identity response error", response.status, responseBody);
    throw new Error("identity fetch failed");
  }

  const payload = await response.json();
  if (!payload.id || !payload.username) {
    throw new Error("Discord identity missing required fields");
  }
  return payload;
}

function generateOverlayCss(rows) {
  const lines = [];

  lines.push(":root,");
  lines.push("html,");
  lines.push("body {");
  lines.push("  background: transparent !important;");
  lines.push("  overflow: hidden !important;");
  lines.push("}");
  lines.push("");
  lines.push("#embed .self-center {");
  lines.push("  display: none !important;");
  lines.push("}");
  lines.push("");
  lines.push("@keyframes talk-bob {");
  lines.push("  0%,");
  lines.push("  100% {");
  lines.push("    transform: translateY(2%);");
  lines.push("  }");
  lines.push("  50% {");
  lines.push("    transform: translateY(0);");
  lines.push("  }");
  lines.push("}");

  for (const row of rows) {
    const avatar = getAvatarByKey(String(row.avatar_key || ""));
    if (!avatar) {
      continue;
    }

    const discordId = cssEscape(String(row.discord_id || ""));
    const displayName = String(row.global_name || row.username || "Unknown");

    lines.push("");
    lines.push(
      `/* ${cssCommentSafe(displayName)} - ${cssCommentSafe(avatar.name)} - Discord ID ${cssCommentSafe(discordId)} */`
    );
    lines.push(`#embed [data-discord-id=\"${discordId}\"] canvas {`);
    lines.push("  opacity: 0 !important;");
    lines.push("}");
    lines.push(`#embed [data-discord-id=\"${discordId}\"] > .relative.flex.shrink-0 {`);
    lines.push("  position: relative !important;");
    lines.push("  background-repeat: no-repeat !important;");
    lines.push("  background-position: center bottom !important;");
    lines.push("  background-size: contain !important;");
    lines.push("  transition: filter 120ms ease, transform 120ms ease !important;");
    lines.push("}");
    lines.push(
      `#embed [data-discord-id=\"${discordId}\"][data-speaking=\"false\"] > .relative.flex.shrink-0 {`
    );
    lines.push(`  background-image: url(\"${cssUrl(avatar.idleUrl)}\") !important;`);
    lines.push("  filter: brightness(0.85);");
    lines.push("}");
    lines.push(
      `#embed [data-discord-id=\"${discordId}\"][data-speaking=\"true\"] > .relative.flex.shrink-0 {`
    );
    lines.push(`  background-image: url(\"${cssUrl(avatar.speakingUrl)}\") !important;`);
    lines.push("  filter: brightness(1);");
    lines.push("  animation: talk-bob 0.6s ease-in-out infinite;");
    lines.push("}");
  }

  return lines.join("\n");
}

function cssEscape(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0).toString(16)} `);
}

function cssUrl(value) {
  return String(value).replace(/["\\\n\r\f]/g, (char) => {
    if (char === '"') return "\\\"";
    if (char === "\\") return "\\\\";
    return "";
  });
}

function cssCommentSafe(value) {
  return String(value).replace(/\*\//g, "* /");
}

function renderHomeHtml({ user, avatars, currentAvatarKey }) {
  const loginSection = user
    ? `<div class=\"identity\"><strong>${escapeHtml(user.globalName || user.username)}</strong> <span class=\"subtle\">(@${escapeHtml(user.username)} | ${escapeHtml(user.discordId)})</span></div>
       <form method=\"post\" action=\"/logout\"><button class=\"button ghost\" type=\"submit\">Log out</button></form>`
    : `<a class=\"button\" href=\"/login\">Login with Discord</a>`;

  const cards = avatars
    .map((avatar) => {
      const selected = user && avatar.key === currentAvatarKey;
      const actionControl = user
        ? `<form method="post" action="/select">
             <input type="hidden" name="avatarKey" value="${escapeHtml(avatar.key)}" />
             <button class="button" type="submit">${selected ? "Selected" : "Select"}</button>
           </form>`
        : `<a class="button" href="/login">Select</a>`;
      return `<article class=\"card ${selected ? "selected" : ""}\">
        <div class="preview-pair">
          <figure class="preview-frame">
            <img src="${escapeHtml(avatar.idleUrl)}" alt="${escapeHtml(avatar.name)} idle preview" loading="lazy" />
          </figure>
          <figure class="preview-frame">
            <img src="${escapeHtml(avatar.speakingUrl)}" alt="${escapeHtml(avatar.name)} talking preview" loading="lazy" />
          </figure>
        </div>
        <div class="card-body">
          <div class="card-topline">
            <h3>${escapeHtml(avatar.name)}</h3>
            ${actionControl}
          </div>
          ${avatar.description ? `<p>${escapeHtml(avatar.description)}</p>` : ""}
        </div>
      </article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Reactive Discord Avatar Selector</title>
    <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />
    <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />
    <link href=\"https://fonts.googleapis.com/css2?family=Jost:wght@400;500;700&display=swap\" rel=\"stylesheet\" />
    <style>
      :root {
        --bg: #ffffff;
        --ink: #111111;
        --ink-muted: #555555;
        --line: #171717;
        --radius: 16px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: \"Jost\", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at 10% 15%, #f3f3f3 0 12%, transparent 13%),
          radial-gradient(circle at 90% 80%, #f0f0f0 0 10%, transparent 11%),
          var(--bg);
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px;
      }
      header {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: center;
        margin-bottom: 20px;
        flex-wrap: wrap;
      }
      h1 {
        margin: 0;
        font-size: clamp(1.6rem, 3vw, 2.4rem);
      }
      .identity {
        font-size: 1rem;
      }
      .subtle {
        display: block;
        color: var(--ink-muted);
      }
      .actions {
        display: flex;
        gap: 10px;
        align-items: center;
      }
      .button {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 8px 14px;
        background: #fff;
        color: var(--ink);
        text-decoration: none;
        font: inherit;
        cursor: pointer;
      }
      .button.ghost {
        background: #f8f8f8;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 14px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        overflow: hidden;
        background: #fff;
      }
      .card.selected {
        box-shadow: 0 0 0 2px #111;
      }
      .preview-pair {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        padding: 8px;
      }
      .preview-frame {
        margin: 0;
        border: 1px solid #d6d6d6;
        border-radius: 10px;
        overflow: hidden;
        background: linear-gradient(180deg, #f8f8f8 0%, #ececec 100%);
      }
      .preview-frame img {
        width: 100%;
        aspect-ratio: 4 / 3;
        object-fit: contain;
        object-position: center;
        display: block;
      }
      .card-body {
        padding: 14px;
      }
      .card-topline {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 2px 2px 0;
      }
      .card h3 {
        margin: 0;
      }
      .card p {
        margin: 8px 0 0;
        color: var(--ink-muted);
      }
      .footer-links {
        margin-top: 18px;
        display: flex;
        gap: 12px;
      }
    </style>
  </head>
  <body>
    <main class=\"wrap\">
      <header>
        <div>
          <h1>Choose Your Avatar</h1>
        </div>
        <div class=\"actions\">${loginSection}</div>
      </header>
      <section class=\"grid\">${cards}</section>
      <div class=\"footer-links\">
        <a href=\"/css\">CSS</a> | 
        <a href=\"/admin\">Admin</a>
      </div>
    </main>
  </body>
</html>`;
}

function renderAdminHtml({ user, rows }) {
  const tableRows = rows
    .map((row) => {
      const displayName = row.global_name || row.username;
      const avatar = getAvatarByKey(String(row.avatar_key || ""));
      return `<tr>
        <td>
          <div><strong>${escapeHtml(displayName)}</strong></div>
          <div class=\"secondary\">@${escapeHtml(String(row.username || ""))} - ${escapeHtml(String(row.discord_id || ""))}</div>
        </td>
        <td>${escapeHtml(avatar?.name || String(row.avatar_key || "Unknown"))}</td>
        <td>${escapeHtml(String(row.updated_at || ""))}</td>
        <td>
          <form method=\"post\" action=\"/admin/remove\">
            <input type=\"hidden\" name=\"discordId\" value=\"${escapeHtml(String(row.discord_id || ""))}\" />
            <button class=\"button danger\" type=\"submit\">Remove</button>
          </form>
        </td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Admin - Reactive Discord Avatar Selector</title>
    <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />
    <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />
    <link href=\"https://fonts.googleapis.com/css2?family=Jost:wght@400;500;700&display=swap\" rel=\"stylesheet\" />
    <style>
      :root {
        --bg: #ffffff;
        --ink: #111111;
        --line: #111111;
      }
      body {
        margin: 0;
        padding: 24px;
        font-family: \"Jost\", sans-serif;
        color: var(--ink);
        background: var(--bg);
      }
      .panel {
        max-width: 1100px;
        margin: 0 auto;
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 18px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .secondary {
        color: #555;
        font-size: 0.9rem;
      }
      table {
        margin-top: 16px;
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        border-top: 1px solid #ddd;
        padding: 10px;
        vertical-align: top;
      }
      .button {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 8px 14px;
        background: #fff;
        color: var(--ink);
        text-decoration: none;
        font: inherit;
        cursor: pointer;
      }
      .danger {
        background: #fff5f5;
      }
      .actions {
        margin-top: 12px;
        display: flex;
        gap: 10px;
      }
    </style>
  </head>
  <body>
    <section class=\"panel\">
      <div class=\"header\">
        <div>
          <h1>Admin Assignments</h1>
          <div class=\"secondary\">Signed in as ${escapeHtml(user.globalName || user.username)} (${escapeHtml(user.discordId)})</div>
        </div>
        <a href=\"/\">Back to selector</a>
      </div>

      <div class=\"actions\">
        <form method=\"post\" action=\"/admin/reset\" onsubmit=\"return confirm('Reset all avatar assignments?');\">
          <button class=\"button danger\" type=\"submit\">Reset All</button>
        </form>
      </div>

      <table>
        <thead>
          <tr>
            <th>Discord Name</th>
            <th>Avatar</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || "<tr><td colspan=\"4\">No assignments yet.</td></tr>"}
        </tbody>
      </table>
    </section>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function htmlResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function createOpaqueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return bytesToBase64Url(bytes);
}

function shouldUseSecureCookie(request) {
  const requestUrl = new URL(request.url);
  return requestUrl.protocol === "https:";
}

function assertRequiredEnv(env) {
  const required = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "SESSION_SECRET"];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }
}
