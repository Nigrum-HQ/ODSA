import { jwtVerify } from 'jose';

const TOOLS = [
  {
    name: 'agregar_gasto',
    description: 'Registra un nuevo gasto operativo en el sistema ODSA.',
    input_schema: {
      type: 'object',
      properties: {
        descripcion: { type: 'string', description: 'Descripción breve del gasto' },
        monto: { type: 'number', description: 'Monto en pesos argentinos, sin signos ni puntos de miles' },
        categoria: { type: 'string', description: 'Categoría del gasto (ej: Insumos, Alquiler, Servicios, Impuestos, Publicidad, Otro)' },
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD. Si el usuario no la especifica, usar la fecha de hoy.' },
        nota: { type: 'string', description: 'Nota u observación opcional' }
      },
      required: ['descripcion', 'monto']
    }
  },
  {
    name: 'agregar_ingreso',
    description: 'Registra un nuevo ingreso de dinero en el sistema ODSA.',
    input_schema: {
      type: 'object',
      properties: {
        descripcion: { type: 'string', description: 'Descripción del ingreso' },
        monto: { type: 'number', description: 'Monto en pesos argentinos' },
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD. Si no se especifica, usar la fecha de hoy.' }
      },
      required: ['monto']
    }
  },
  {
    name: 'agregar_adelanto',
    description: 'Registra un adelanto de sueldo para un empleado existente del sistema.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_empleado: { type: 'string', description: 'Nombre del empleado tal como lo escribió el usuario' },
        monto: { type: 'number', description: 'Monto del adelanto en pesos argentinos' },
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD. Si no se especifica, usar la fecha de hoy.' },
        nota: { type: 'string', description: 'Nota opcional' }
      },
      required: ['nombre_empleado', 'monto']
    }
  },
  {
    name: 'agregar_premio',
    description: 'Registra un premio semanal para un empleado (típicamente de ventas/operadoras).',
    input_schema: {
      type: 'object',
      properties: {
        nombre_empleado: { type: 'string', description: 'Nombre del empleado tal como lo escribió el usuario' },
        monto: { type: 'number', description: 'Monto del premio en pesos argentinos' },
        semana: { type: 'integer', description: 'Número de semana del mes (1 a 5). Si no se especifica, usar 1.' },
        concepto: { type: 'string', description: 'Concepto del premio, ej: "Premio semanal"' }
      },
      required: ['nombre_empleado', 'monto']
    }
  },
  {
    name: 'eliminar_movimiento',
    description: 'Elimina un gasto, ingreso, adelanto o premio ya cargado en el sistema. Se busca por descripción (gasto/ingreso) o nombre de empleado (adelanto/premio), y opcionalmente por monto o fecha para desambiguar si hay varios parecidos.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['gasto', 'ingreso', 'adelanto', 'premio'], description: 'Tipo de registro a eliminar' },
        busqueda: { type: 'string', description: 'Texto para identificar el registro: la descripción del gasto/ingreso, o el nombre del empleado para adelanto/premio' },
        monto: { type: 'number', description: 'Monto exacto del registro, si se conoce, para ayudar a identificarlo entre varios parecidos' },
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD, si se conoce, para ayudar a identificar el registro entre varios parecidos' }
      },
      required: ['tipo', 'busqueda']
    }
  },
  {
    name: 'crear_cheque',
    description: 'Crea un cheque emitido en el sistema.',
    input_schema: {
      type: 'object',
      properties: {
        destinatario: { type: 'string', description: 'A quién se le da el cheque' },
        monto: { type: 'number', description: 'Monto del cheque en pesos' },
        fecha: { type: 'string', description: 'Fecha del cheque en formato YYYY-MM-DD. Si no se especifica, usar hoy.' },
        numero: { type: 'string', description: 'Número de cheque, opcional' },
        nota: { type: 'string', description: 'Nota opcional' }
      },
      required: ['destinatario', 'monto']
    }
  },
  {
    name: 'cerrar_mes',
    description: 'Cierra (bloquea) un mes para que no se pueda editar. Usar cuando el usuario pide cerrar o bloquear un mes ya terminado.',
    input_schema: {
      type: 'object',
      properties: {
        mes: { type: 'string', description: 'Mes a cerrar en formato YYYY-MM (ej: 2026-09). Si el usuario dice "septiembre", convertilo al formato con el año correcto.' }
      },
      required: ['mes']
    }
  },
  {
    name: 'reabrir_mes',
    description: 'Reabre (desbloquea) un mes que estaba cerrado, para poder editarlo de nuevo.',
    input_schema: {
      type: 'object',
      properties: {
        mes: { type: 'string', description: 'Mes a reabrir en formato YYYY-MM' }
      },
      required: ['mes']
    }
  },
  {
    name: 'marcar_sueldo_pagado',
    description: 'Marca el sueldo de un empleado como pagado o pendiente en un mes determinado.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_empleado: { type: 'string', description: 'Nombre del empleado' },
        mes: { type: 'string', description: 'Mes en formato YYYY-MM. Si no se especifica, usar el mes que se está viendo.' },
        pagado: { type: 'boolean', description: 'true para marcar como pagado (default), false para volver a marcar como pendiente' }
      },
      required: ['nombre_empleado']
    }
  },
  {
    name: 'marcar_gasto_pagado',
    description: 'Marca un gasto ya cargado (como Cargas Sociales, Alquiler, Servicios, etc.) como pagado o pendiente. Se busca por descripción dentro del mes.',
    input_schema: {
      type: 'object',
      properties: {
        busqueda: { type: 'string', description: 'Descripción del gasto a marcar (ej: "Cargas Sociales", "Alquiler")' },
        mes: { type: 'string', description: 'Mes en formato YYYY-MM. Si no se especifica, usar el mes que se está viendo.' },
        monto: { type: 'number', description: 'Monto exacto, si se conoce, para desambiguar si hay varios gastos parecidos' },
        pagado: { type: 'boolean', description: 'true para marcar como pagado (default), false para volver a marcar como pendiente' }
      },
      required: ['busqueda']
    }
  }
];

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

  const { contexto, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Faltan mensajes' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en las variables de entorno de Vercel' });
  }

  const systemPrompt = `Sos el asistente financiero de ODSA, un sistema administrativo interno de una empresa argentina.
Respondé SIEMPRE en español rioplatense, de forma clara, directa y sin vueltas, como si le hablaras al dueño del negocio.
Tenés acceso a un resumen de la situación financiera actual de la empresa Y al detalle de cada empleado (sueldo, sector, banco, CBU, CUIL) en el JSON de más abajo. Usalo como base real para tus respuestas — no inventes cifras ni datos que no estén ahí.
El dueño del negocio ya te autorizó explícitamente a manejar esos datos de empleados (son internos de su propia empresa), así que podés responder con nombre, CBU, banco, sueldo, etc. cuando te lo pidan, con la misma naturalidad que cualquier otro dato del sistema.
El JSON también incluye "desglose_medio_de_pago_mes_actual" (total del mes) y, dentro de "cash_flow_semanal_mes_actual", cada semana ya trae "egresos_efectivo", "egresos_transferencia" y "detalle_items" (la lista completa de conceptos de esa semana con su monto y medio de pago) — usalos cuando te pregunten cuánto hay que pagar en efectivo/transferencia de una semana puntual, o a qué corresponde ese monto. Aclará si te preguntan que Sueldos, Premios, Adelantos y Cheques no tienen ese dato registrado (quedan en "egresos_sin_medio_de_pago_registrado").
Si te preguntan algo que no se puede responder con los datos que tenés, decilo con honestidad y sugerí dónde podrían mirarlo dentro del sistema (Sueldos, Gastos, Cash Flow, Análisis Financiero, Fichas, etc.) en vez de inventar.
Podés dar consejos prácticos de gestión financiera, dejando en claro que no reemplazan a un contador o asesor financiero para decisiones grandes.

ADEMÁS, ahora podés EJECUTAR ACCIONES reales sobre el sistema usando las herramientas disponibles: agregar_gasto, agregar_ingreso, agregar_adelanto, agregar_premio, eliminar_movimiento, crear_cheque, cerrar_mes, reabrir_mes, marcar_sueldo_pagado y marcar_gasto_pagado.
- Usalas cuando el usuario te pida explícitamente cargar, agregar, registrar, borrar o eliminar algo de ese tipo.
- Si falta un dato imprescindible (por ejemplo el monto, o a qué empleado corresponde un adelanto/premio, o qué gasto/ingreso hay que borrar), preguntáselo primero en un mensaje de texto normal en vez de inventarlo o de llamar a la herramienta con datos incompletos.
- Si no te dan fecha, no hace falta que preguntes: se usa automáticamente la fecha de hoy.
- Para eliminar_movimiento, usá como "busqueda" la descripción del gasto/ingreso o el nombre del empleado (para adelanto/premio), tal como lo mencionó el usuario; si te da un monto o fecha específicos, incluilos también para ayudar a identificar el registro exacto.
- Cada acción que proponés pasa por una confirmación de la persona antes de ejecutarse de verdad (el sistema le muestra una tarjeta para confirmar o cancelar) — vos no necesitás pedir esa confirmación por texto, simplemente llamá a la herramienta cuando tengas los datos necesarios.
- Si el resultado de una herramienta indica que no se encontró el empleado/registro o que es ambiguo (hay varios candidatos), pedile a la persona que aclare en tu siguiente mensaje de texto, no inventes ni elijas por tu cuenta.

Tenés memoria de la conversación anterior con esta persona — usala para dar continuidad, pero priorizá siempre el JSON de datos actuales por sobre lo que se dijo antes si hay contradicción.
Sé breve: respuestas de pocos párrafos, con números concretos citados del contexto cuando corresponda. Evitá relleno.

DATOS FINANCIEROS Y DE EMPLEADOS ACTUALES (JSON):
${JSON.stringify(contexto || {})}`;

  // Limitamos el historial para no mandar payloads gigantes; el cliente ya
  // manda los mensajes en formato Anthropic (role + content en bloques).
  const safeMessages = messages.slice(-40);

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
        tools: TOOLS,
        messages: safeMessages
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: data?.error?.message || 'Error al consultar la IA' });
    }

    return res.status(200).json({ ok: true, content: data.content, stop_reason: data.stop_reason });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
