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

  const { pregunta, contexto, historial } = req.body || {};
  if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en las variables de entorno de Vercel' });
  }

  const systemPrompt = `Sos el asistente financiero de ODSA, un sistema administrativo interno de una empresa argentina.
Respondé SIEMPRE en español rioplatense, de forma clara, directa y sin vueltas, como si le hablaras al dueño del negocio.
Tenés acceso a un resumen de la situación financiera actual de la empresa (más abajo, en formato JSON). Usalo como base real para tus respuestas — no inventes cifras que no estén ahí.
Si te preguntan algo que no se puede responder con los datos que tenés (por ejemplo, detalle de una factura puntual, o de un mes que no está en el resumen), decilo con honestidad y sugerí dónde podrían mirarlo dentro del sistema (Sueldos, Gastos, Cash Flow, Análisis Financiero, etc.) en vez de inventar.
Podés dar consejos prácticos de gestión financiera (flujo de caja, control de gastos, prioridades de pago), pero dejando en claro que no reemplazan a un contador o asesor financiero para decisiones grandes (impuestos, inversiones, préstamos).
Sé breve: respuestas de pocos párrafos, con números concretos citados del contexto cuando corresponda. Evitá relleno.

DATOS FINANCIEROS ACTUALES (JSON):
${JSON.stringify(contexto || {})}`;

  const messages = [
    ...(Array.isArray(historial) ? historial.slice(-10).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: String(h.content || '').slice(0, 4000)
    })) : []),
    { role: 'user', content: String(pregunta).slice(0, 4000) }
  ];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: data?.error?.message || 'Error al consultar la IA' });
    }

    const respuesta = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({ ok: true, respuesta });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
