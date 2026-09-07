import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');

  if (req.method !== 'GET' && req.method !== 'POST') {
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

  const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 0 } },
    global: { headers: { 'x-my-custom-header': 'odsa' } }
  });

  // Filtro opcional por mes: /api/listComprobantes?mes=2026-10
  const mes = (req.query && req.query.mes) ? req.query.mes : null;

  try {
    let q = supabase.from('odsa_comprobantes').select('*').order('fecha', { ascending: false });
    if (mes) q = q.eq('mes', mes);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Generar URL firmada (válida 1 hora) para cada archivo, así se puede ver aunque el bucket sea privado
    const conUrls = await Promise.all((data || []).map(async (r) => {
      let url = null;
      if (r.archivo_path) {
        const { data: signed } = await supabase.storage
          .from('comprobantes')
          .createSignedUrl(r.archivo_path, 3600);
        url = signed ? signed.signedUrl : null;
      }
      return { ...r, archivo_url: url };
    }));

    return res.status(200).json({ ok: true, comprobantes: conUrls });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
