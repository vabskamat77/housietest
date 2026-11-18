import { getDb, getStripe } from '../lib/server.js';
import { setCors, requireMethod } from '../lib/server.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (!requireMethod(req, res, 'GET')) return;
  const sessionId = String(req.query.session_id || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return res.status(400).json({ error: 'Invalid Checkout Session ID' });

  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return res.status(402).json({ status: 'unpaid', error: 'Stripe has not confirmed payment for this session.' });
    const db = getDb();
    const snap = await db.collection('stripe_payment_sessions').doc(sessionId).get();
    if (!snap.exists) return res.status(202).json({ status: 'processing', error: 'Payment is confirmed; token creation is still processing.' });
    const record = snap.data();
    return res.status(200).json({ status: 'fulfilled', token: record.token, tier: record.tier, maxTickets: record.maxTickets });
  } catch (err) {
    console.error('Payment status lookup failed:', err);
    return res.status(500).json({ error: 'Unable to verify payment right now.' });
  }
}
