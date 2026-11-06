import { createClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';
import { createHmac, timingSafeEqual } from 'crypto';

// Llave que firma cada pedido a la base de datos: la base solo responde a pedidos que la traen.
// Se deriva de JWT_SECRET (configurado en Vercel), así nunca aparece en el código.
const odsaDbKey = () => createHmac('sha256', process.env.JWT_SECRET).update('odsa-db-v1').digest('hex');

const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-odsa-key': odsaDbKey() } }
});

// Límite de intentos: después de 8 intentos fallidos en 15 minutos (por email o por IP)
// se bloquea el login un rato, para que nadie pueda probar contraseñas sin parar.
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
  } catch {
    return false; // si falla el control, no bloqueamos a nadie
  }
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

function verifyHash(password, stored) {
  const [salt, expectedHash] = stored.split(':');
  if (!salt || !expectedHash) return false;
  const actualHash = createHmac('sha256', salt).update(password).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
  } catch {
    return false;
  }
}

async function emitirToken(id, email) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  return new SignJWT({ id, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });
  const emailNorm = String(email).toLowerCase().trim();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';

  if (await demasiadosIntentos(emailNorm, ip)) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.' });
  }

  // Acceso admin temporal por variable de entorno
  const adminPass = process.env.ADMIN_PASSWORD;
  const adminEmail = process.env.ADMIN_EMAIL || 'administracion@abesa.co';
  if (adminPass && emailNorm === adminEmail && password === adminPass) {
    await limpiarFallos(emailNorm);
    return res.status(200).json({ ok: true, token: await emitirToken(0, adminEmail) });
  }

  try {
    const { data, error } = await supabase
      .from('odsa_usuarios')
      .select('id, email, password_hash')
      .eq('email', emailNorm)
      .single();

    if (error || !data || !verifyHash(password, data.password_hash)) {
      await registrarFallo(emailNorm, ip);
      return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos' });
    }

    await limpiarFallos(emailNorm);
    return res.status(200).json({ ok: true, token: await emitirToken(data.id, data.email) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
