import { createClient } from '@supabase/supabase-js';
import { createHmac as _odsaHmac } from 'crypto';
// Llave que firma cada pedido a la base de datos: la base solo responde a pedidos que la traen.
// Se deriva de JWT_SECRET (configurado en Vercel), así nunca aparece en el código.
const odsaDbKey = () => _odsaHmac('sha256', process.env.JWT_SECRET).update('odsa-db-v1').digest('hex');
import { jwtVerify } from 'jose';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload: _p } = await jwtVerify(token, secret);
    if (_p.etapa !== 'sesion') throw new Error('sesión incompleta'); // exige haber completado la verificación en dos pasos
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  // Cliente sin auth/realtime para evitar llamadas extras de inicialización
  const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 0 } },
    global: { headers: { 'x-my-custom-header': 'odsa', 'x-odsa-key': odsaDbKey() } }
  });

  // Usuario activo y sesión no revocada (al desactivar a alguien o reiniciar su 2FA, sus sesiones se cortan)
  try {
    const { payload: _s } = await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET));
    const { data: _u } = await supabase.from('odsa_usuarios').select('activo, token_version').eq('id', _s.id).single();
    if (!_u || _u.activo === false || (_u.token_version || 1) !== _s.tv) return res.status(401).json({ error: 'Sesión revocada' });
  } catch { return res.status(401).json({ error: 'Sesión inválida' }); }

  try {
    const { data, error } = await supabase
      .from('odsa_data')
      .select('data')
      .eq('id', 1)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, data: data?.data || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
