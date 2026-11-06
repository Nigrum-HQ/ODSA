import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

// Configuración inicial (se usa una sola vez): registra en la base la llave con la que
// el servidor firma sus pedidos. La base la acepta solo si todavía no hay ninguna cargada.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const key = createHmac('sha256', process.env.JWT_SECRET).update('odsa-db-v1').digest('hex');
    const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data, error } = await supabase.rpc('odsa_set_dbkey', { p_hash: key });
    if (error) return res.status(200).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, registrada: data === true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
