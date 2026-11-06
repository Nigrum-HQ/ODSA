// IPC oficial del INDEC (nivel general, cobertura nacional) para calcular aumentos.
// Se descarga del sitio del INDEC del lado del servidor (el navegador no puede por CORS)
// y se cachea 12 horas. Devuelve { ok, ultimo: 'AAAA-MM', indices: { 'AAAA-MM': valor } }.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const r = await fetch('https://www.indec.gob.ar/ftp/cuadros/economia/serie_ipc_divisiones.csv');
    if (!r.ok) throw new Error('El INDEC respondió ' + r.status);
    const txt = Buffer.from(await r.arrayBuffer()).toString('latin1');
    const indices = {};
    for (const line of txt.split(/\r?\n/)) {
      const c = line.split(';');
      if (c.length < 8) continue;
      // c[0] = código ("0" = nivel general), c[3] = período AAAAMM, c[4] = índice, c[7] = región
      if (c[0].replace(/"/g, '').trim() !== '0') continue;
      if (!/nacional/i.test(c[7])) continue;
      const p = c[3].replace(/"/g, '').trim();
      if (!/^\d{6}$/.test(p)) continue;
      const v = parseFloat(c[4].replace(/"/g, '').trim().replace(',', '.'));
      if (!isFinite(v)) continue;
      indices[p.slice(0, 4) + '-' + p.slice(4)] = v;
    }
    const meses = Object.keys(indices).sort();
    if (!meses.length) throw new Error('No se encontraron índices en el archivo del INDEC');
    return res.status(200).json({
      ok: true,
      fuente: 'INDEC - IPC nivel general, cobertura nacional (base dic 2016 = 100)',
      ultimo: meses[meses.length - 1],
      indices
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}
