import { createClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';
import { createHmac, timingSafeEqual } from 'crypto';

const supabase = createClient(
  process.env.SUPA_URL,
  process.env.SUPA_KEY
);

function verifyHash(password, stored) {
  const [salt, expectedHash] = stored.split(':');
  if (!salt || !expectedHash) return false;
  const actualHash = createHmac('sha256', salt).update(password).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  try {
    const { data, error } = await supabase
      .from('odsa_usuarios')
      .select('id, email, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !data) {
      return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos' });
    }

    const valid = verifyHash(password, data.password_hash);

    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos' });
    }

    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const token = await new SignJWT({ id: data.id, email: data.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(secret);

    return res.status(200).json({ ok: true, token });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
