import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPA_URL,
  process.env.SUPA_KEY
);

function verifyServiceToken(req) {
  const token = req.headers['x-service-token'] || '';
  return token === process.env.ABESA_SERVICE_TOKEN;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-service-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyServiceToken(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    const { data, error } = await supabase
      .from('odsa_data')
      .select('data')
      .eq('id', 1)
      .single();

    if (error) throw error;

    const raw = data?.data;
    const d = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    const mesActual = new Date().toISOString().substring(0, 7);

    const gastos = (d.gastos || []).filter(g => (g.fecha || '').startsWith(mesActual));
    const totalGastos = gastos.reduce((s, g) => s + (g.monto || 0), 0);
    const gastosPagados = gastos.filter(g => g.estado === 'Pagada' || g.estado === 'pagado').reduce((s, g) => s + (g.monto || 0), 0);
    const gastosPendientes = totalGastos - gastosPagados;

    const ingresosMes = (d.ingresos || []).filter(i => (i.fecha || '').startsWith(mesActual));
    const totalIngresos = ingresosMes.reduce((s, i) => s + (i.monto || 0), 0);

    return res.status(200).json({
      ok: true,
      mes: mesActual,
      ingresos: totalIngresos,
      gastos: totalGastos,
      gastos_pagados: gastosPagados,
      gastos_pendientes: gastosPendientes,
      resultado: totalIngresos - totalGastos,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
