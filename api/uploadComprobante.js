import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';

// Aumentamos el límite del body para permitir el archivo en base64 (hasta ~10MB → ~14MB en base64)
export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

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

  const { beneficiario, tipo, concepto, monto, fecha, archivo_base64, archivo_nombre, archivo_tipo } = req.body || {};

  if (!beneficiario || !fecha) {
    return res.status(400).json({ error: 'Faltan datos obligatorios (beneficiario y fecha)' });
  }

  const supabase = createClient(process.env.SUPA_URL, process.env.SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 0 } },
    global: { headers: { 'x-my-custom-header': 'odsa' } }
  });

  const mes = String(fecha).slice(0, 7); // YYYY-MM

  try {
    let archivo_path = null;

    // Subir el archivo al bucket, si vino uno
    if (archivo_base64 && archivo_nombre) {
      // archivo_base64 puede venir como "data:image/jpeg;base64,...." — sacamos el prefijo
      const comaIdx = archivo_base64.indexOf(',');
      const rawB64 = comaIdx >= 0 ? archivo_base64.slice(comaIdx + 1) : archivo_base64;
      const buffer = Buffer.from(rawB64, 'base64');

      // Nombre único: mes/timestamp-nombreoriginal
      const safeName = String(archivo_nombre).replace(/[^a-zA-Z0-9._-]/g, '_');
      archivo_path = `${mes}/${Date.now()}-${safeName}`;

      const { error: upErr } = await supabase.storage
        .from('comprobantes')
        .upload(archivo_path, buffer, {
          contentType: archivo_tipo || 'application/octet-stream',
          upsert: false
        });

      if (upErr) return res.status(500).json({ error: 'Error al subir archivo: ' + upErr.message });
    }

    // Guardar el registro en la tabla
    const { data, error } = await supabase
      .from('odsa_comprobantes')
      .insert({
        beneficiario,
        tipo: tipo || null,
        concepto: concepto || null,
        monto: Number(monto) || 0,
        fecha,
        mes,
        archivo_path,
        archivo_nombre: archivo_nombre || null,
        archivo_tipo: archivo_tipo || null
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ ok: true, registro: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
