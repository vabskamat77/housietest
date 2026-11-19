import {
  getDb,
  getStripe,
  setCors,
  requireMethod
} from '../lib/server.js';

export default async function handler(req, res) {
  setCors(req, res);

  if (!requireMethod(req, res, 'GET')) return;

  res.setHeader('Cache-Control', 'no-store');

  const sessionId = String(req.query.session_id || '');

  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return res.status(400).json({
      error: 'Invalid Checkout Session ID'
    });
  }

  try {
    const session = await getStripe()
      .checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({
        status: 'unpaid',
        error: 'Stripe has not confirmed payment.'
      });
    }

    const snap = await getDb()
      .collection('stripe_payment_sessions')
      .doc(sessionId)
      .get();

    if (!snap.exists || !snap.data()?.token) {
      return res.status(202).json({
        status: 'processing',
        message:
          'Payment confirmed. Host Token issuance is processing.'
      });
    }

    const record = snap.data();

    return res.status(200).json({
      status: 'fulfilled',
      tier: record.tier,
      maxTickets: record.maxTickets,
      emailStatus: record.emailStatus === 'sent'
        ? 'sent'
        : 'processing'
    });

  } catch (err) {
    console.error('Payment status lookup failed:', err);

    return res.status(500).json({
      error: 'Unable to verify payment right now.'
    });
  }
}
