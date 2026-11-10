import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';
import { createHmac, createHash, randomBytes } from 'crypto';

// Administración de usuarios (solo para el rol "admin"): alta con enlace de activación,
// nuevo enlace (reinicia contraseña y 2FA), reinicio del 2FA, y activar/desactivar.
const odsaDbKey = () => createHmac('sha256', process.env.JWT_SECRET).update('odsa-db-v1').digest('hex');
const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-odsa-key': odsaDbKey() } }
});

async function adminDeLaSesion(req) {
  const token = String(req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  let p;
  try { p = (await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET))).payload; } catch { return null; }
  if (p.etapa !== 'sesion') return null;
  const { data: u } = await supabase.from('odsa_usuarios').select('id, rol, activo, token_version').eq('id', p.id).single();
  if (!u || !u.activo || (u.token_version || 1) !== p.tv || u.rol !== 'admin') return null;
  return u;
}
function nuevoEnlace(req) {
  const token = randomBytes(32).toString('hex');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'odsa.vercel.app';
  return {
    token,
    hash: createHash('sha256').update(token).digest('hex'),
    expira: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    url: 'https://' + host + '/#activar=' + token
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const admin = await adminDeLaSesion(req);
  if (!admin) return res.status(403).json({ ok: false, error: 'Solo el administrador puede gestionar usuarios' });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('odsa_usuarios')
        .select('id, email, nombre, rol, activo, totp_activo, ultimo_login, setup_expira')
        .order('id');
      if (error) throw error;
      return res.status(200).json({ ok: true, yo: admin.id, usuarios: data });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const { accion, id, email, nombre } = req.body || {};
    if (accion === 'crear') {
      const e = String(email || '').toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ ok: false, error: 'Email inválido' });
      const l = nuevoEnlace(req);
      const { error } = await supabase.from('odsa_usuarios').insert({
        email: e, nombre: String(nombre || '').trim() || null, rol: 'usuario', activo: true,
        password_hash: '', setup_hash: l.hash, setup_expira: l.expira
      });
      if (error) return res.status(400).json({ ok: false, error: /duplicate|unique/i.test(error.message) ? 'Ya existe un usuario con ese email' : error.message });
      return res.status(200).json({ ok: true, enlace: l.url, vence: l.expira });
    }

    const objetivo = parseInt(id, 10);
    const { data: u } = await supabase.from('odsa_usuarios').select('id, token_version').eq('id', objetivo).single();
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    const tv = (u.token_version || 1) + 1;

    if (accion === 'enlace') {
      const l = nuevoEnlace(req);
      await supabase.from('odsa_usuarios').update({ setup_hash: l.hash, setup_expira: l.expira }).eq('id', u.id);
      return res.status(200).json({ ok: true, enlace: l.url, vence: l.expira });
    }
    if (accion === 'reset2fa') {
      await supabase.from('odsa_usuarios').update({ totp_activo: false, totp_secret: null, totp_ultimo_paso: 0, token_version: tv }).eq('id', u.id);
      return res.status(200).json({ ok: true });
    }
    if (accion === 'desactivar' || accion === 'activar') {
      if (u.id === admin.id) return res.status(400).json({ ok: false, error: 'No podés desactivar tu propio usuario' });
      await supabase.from('odsa_usuarios').update({ activo: accion === 'activar', token_version: tv, setup_hash: null, setup_expira: null }).eq('id', u.id);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Acción desconocida' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
}
