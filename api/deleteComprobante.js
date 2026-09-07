import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    await jwtVerify(token, secret);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Falta id' });

  const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 0 } },
    global: { headers: { 'x-my-custom-header': 'odsa' } }
  });

  try {
    // Buscar el registro para saber qué archivo borrar del storage
    const { data: rec } = await supabase.from('odsa_comprobantes').select('archivo_path').eq('id', id).single();

    if (rec && rec.archivo_path) {
      await supabase.storage.from('comprobantes').remove([rec.archivo_path]);
    }

    const { error } = await supabase.from('odsa_comprobantes').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
