import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');

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

  try {
    // GET: listar backups (sin el data completo, solo metadata)
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('odsa_backups')
        .select('id, origen, creado_en')
        .order('creado_en', { ascending: false })
        .limit(60);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, backups: data || [] });
    }

    if (req.method === 'POST') {
      const accion = (req.body && req.body.accion) || 'crear';

      // Restaurar un backup: devuelve el data para que el cliente lo cargue
      if (accion === 'restaurar') {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'Falta id' });
        const { data, error } = await supabase.from('odsa_backups').select('data').eq('id', id).single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true, data: data.data });
      }

      // Crear backup
      const { data: dataToBackup, auto } = req.body;
      if (!dataToBackup) return res.status(400).json({ error: 'Falta data' });

      // Si es automático, solo crear uno por día (evita acumular decenas por día)
      if (auto) {
        const hoy = new Date().toISOString().slice(0, 10);
        const { data: existentes } = await supabase
          .from('odsa_backups')
          .select('id, creado_en')
          .eq('origen', 'auto')
          .gte('creado_en', hoy + 'T00:00:00Z')
          .limit(1);
        if (existentes && existentes.length > 0) {
          return res.status(200).json({ ok: true, skipped: 'ya existe backup automático de hoy' });
        }
      }

      const { error: insErr } = await supabase
        .from('odsa_backups')
        .insert({ data: dataToBackup, origen: auto ? 'auto' : 'manual' });
      if (insErr) return res.status(500).json({ error: insErr.message });

      // Limpiar: mantener solo los últimos 30 backups
      const { data: todos } = await supabase
        .from('odsa_backups')
        .select('id')
        .order('creado_en', { ascending: false });
      if (todos && todos.length > 30) {
        const paraBorrar = todos.slice(30).map(b => b.id);
        await supabase.from('odsa_backups').delete().in('id', paraBorrar);
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
