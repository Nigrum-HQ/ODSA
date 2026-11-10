import { createClient } from '@supabase/supabase-js';
import { SignJWT, jwtVerify } from 'jose';
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'crypto';

// ─── Acceso a la base (cada pedido va firmado; la base solo responde a pedidos firmados) ───
const odsaDbKey = () => createHmac('sha256', process.env.JWT_SECRET).update('odsa-db-v1').digest('hex');
const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-odsa-key': odsaDbKey() } }
});
const jwtKey = () => new TextEncoder().encode(process.env.JWT_SECRET);

// ─── Límite de intentos: 8 fallos en 15 minutos (por email o por IP) bloquean un rato ───
const MAX_INTENTOS = 8;
const VENTANA_MS = 15 * 60 * 1000;
async function demasiadosIntentos(email, ip) {
  try {
    const desde = new Date(Date.now() - VENTANA_MS).toISOString();
    const [porEmail, porIp] = await Promise.all([
      supabase.from('odsa_login_intentos').select('id', { count: 'exact', head: true }).gte('creado_en', desde).eq('email', email),
      supabase.from('odsa_login_intentos').select('id', { count: 'exact', head: true }).gte('creado_en', desde).eq('ip', ip)
    ]);
    return (porEmail.count || 0) >= MAX_INTENTOS || (porIp.count || 0) >= MAX_INTENTOS;
  } catch { return false; }
}
async function registrarFallo(email, ip) {
  try {
    await supabase.from('odsa_login_intentos').insert({ email, ip });
    await supabase.from('odsa_login_intentos').delete().lt('creado_en', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  } catch {}
}
async function limpiarFallos(email) {
  try { await supabase.from('odsa_login_intentos').delete().eq('email', email); } catch {}
}

// ─── Contraseñas: nuevas con scrypt; las viejas (HMAC) se siguen aceptando y se actualizan solas ───
function hashPassword(pass) {
  const salt = randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function verifyPassword(pass, stored) {
  if (!stored) return false;
  try {
    if (stored.startsWith('scrypt$')) {
      const [, salt, h] = stored.split('$');
      const a = scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }), b = Buffer.from(h, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    }
    const [salt, expected] = stored.split(':');
    if (!salt || !expected) return false;
    const actual = createHmac('sha256', salt).update(pass).digest('hex');
    return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch { return false; }
}

// ─── Verificación en dos pasos (TOTP, compatible con Google Authenticator) ───
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function nuevoSecretoTotp() {
  let bits = '', out = '';
  for (const x of randomBytes(20)) bits += x.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const c of String(s).toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1000000).padStart(6, '0');
}
// Devuelve el paso de tiempo del código si es válido (acepta ±30 s de diferencia), o 0. Un código no se puede reusar.
function verificarTotp(secret, code, ultimoPaso) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  const ahora = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const paso = ahora + d;
    if (paso <= (ultimoPaso || 0)) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, paso)), Buffer.from(c))) return paso;
  }
  return 0;
}
// El secreto del 2FA se guarda cifrado en la base
const encKey = () => createHash('sha256').update(process.env.JWT_SECRET + '|odsa-totp-v1').digest();
function cifrar(txt) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(txt, 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}
function descifrar(s) {
  const [v, iv, tag, ct] = String(s).split(':');
  if (v !== 'v1') throw new Error('formato');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ─── Tokens: "paso" (10 min, solo sirve para terminar el login) y "sesion" (8 h) ───
const emitirPaso = (u, etapa) => new SignJWT({ id: u.id, email: u.email, tv: u.token_version || 1, etapa })
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(jwtKey());
const emitirSesion = (u) => new SignJWT({ id: u.id, email: u.email, rol: u.rol || 'usuario', tv: u.token_version || 1, etapa: 'sesion' })
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('8h').sign(jwtKey());

const CAMPOS = 'id, email, nombre, rol, activo, password_hash, totp_secret, totp_activo, totp_ultimo_paso, token_version';

// Después de la contraseña: si ya tiene 2FA pide el código; si no, prepara el alta del 2FA
async function siguientePaso(u, res) {
  if (u.totp_activo && u.totp_secret) {
    return res.status(200).json({ ok: true, paso: 'totp', pre: await emitirPaso(u, 'totp'), nombre: u.nombre || '' });
  }
  const secreto = nuevoSecretoTotp();
  await supabase.from('odsa_usuarios').update({ totp_secret: cifrar(secreto), totp_activo: false }).eq('id', u.id);
  const uri = 'otpauth://totp/' + encodeURIComponent('ODSA:' + u.email) + '?secret=' + secreto + '&issuer=ODSA&algorithm=SHA1&digits=6&period=30';
  return res.status(200).json({ ok: true, paso: 'alta2fa', pre: await emitirPaso(u, 'alta2fa'), secreto, uri, email: u.email });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';

  try {
    // 1) Activar una cuenta nueva (o reiniciada) con el enlace que genera el administrador
    if (body.activar) {
      const pass = String(body.password || '');
      if (pass.length < 8) return res.status(400).json({ ok: false, error: 'La contraseña tiene que tener al menos 8 caracteres' });
      if (await demasiadosIntentos('activacion', ip)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Esperá 15 minutos.' });
      const h = createHash('sha256').update(String(body.activar)).digest('hex');
      const { data: u } = await supabase.from('odsa_usuarios').select(CAMPOS + ', setup_expira').eq('setup_hash', h).single();
      if (!u || !u.activo || !u.setup_expira || new Date(u.setup_expira) < new Date()) {
        await registrarFallo('activacion', ip);
        return res.status(400).json({ ok: false, error: 'El enlace no es válido o ya venció. Pedile uno nuevo al administrador.' });
      }
      const tv = (u.token_version || 1) + 1;
      await supabase.from('odsa_usuarios').update({
        password_hash: hashPassword(pass), setup_hash: null, setup_expira: null,
        totp_activo: false, totp_secret: null, totp_ultimo_paso: 0, token_version: tv
      }).eq('id', u.id);
      return siguientePaso({ ...u, token_version: tv, totp_activo: false, totp_secret: null }, res);
    }

    // 2) Segundo paso: código de 6 dígitos (login normal o alta del 2FA)
    if (body.pre) {
      let p;
      try { p = (await jwtVerify(String(body.pre), jwtKey())).payload; } catch { p = null; }
      if (!p || !['totp', 'alta2fa'].includes(p.etapa)) return res.status(401).json({ ok: false, error: 'Se venció el tiempo. Volvé a ingresar tu contraseña.' });
      const { data: u } = await supabase.from('odsa_usuarios').select(CAMPOS).eq('id', p.id).single();
      if (!u || !u.activo || (u.token_version || 1) !== p.tv || !u.totp_secret) return res.status(401).json({ ok: false, error: 'Volvé a ingresar tu contraseña.' });
      if (await demasiadosIntentos(u.email, ip)) return res.status(429).json({ ok: false, error: 'Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.' });
      const paso = verificarTotp(descifrar(u.totp_secret), body.codigo, u.totp_ultimo_paso);
      if (!paso) {
        await registrarFallo(u.email, ip);
        return res.status(401).json({ ok: false, error: 'Código incorrecto. Revisá que sea el de ODSA en tu app y que no haya vencido.' });
      }
      await supabase.from('odsa_usuarios').update({ totp_ultimo_paso: paso, totp_activo: true, ultimo_login: new Date().toISOString() }).eq('id', u.id);
      await limpiarFallos(u.email);
      return res.status(200).json({ ok: true, token: await emitirSesion(u) });
    }

    // 3) Primer paso: email y contraseña
    const { email, password } = body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    const emailNorm = String(email).toLowerCase().trim();
    if (await demasiadosIntentos(emailNorm, ip)) return res.status(429).json({ ok: false, error: 'Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.' });

    const { data: u } = await supabase.from('odsa_usuarios').select(CAMPOS).ilike('email', emailNorm).maybeSingle();
    // Acceso de administrador configurado en Vercel: entra como la cuenta de administración, también con 2FA
    const adminPass = process.env.ADMIN_PASSWORD;
    const adminEmail = String(process.env.ADMIN_EMAIL || 'administracion@abesa.co').toLowerCase();
    const okAdminEnv = !!adminPass && emailNorm === adminEmail && password === adminPass;
    const okPass = u && verifyPassword(password, u.password_hash);
    if (!u || !u.activo || !(okPass || okAdminEnv)) {
      await registrarFallo(emailNorm, ip);
      return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos' });
    }
    if (okPass && !String(u.password_hash).startsWith('scrypt$')) {
      await supabase.from('odsa_usuarios').update({ password_hash: hashPassword(password) }).eq('id', u.id);
    }
    return siguientePaso(u, res);
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
}
