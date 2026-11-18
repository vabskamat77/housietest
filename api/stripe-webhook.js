import { randomBytes } from 'node:crypto';
import { getDb, getStripe, appId } from '../lib/server.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function packageForLineItems(lineItems, currency) {
  if (currency !== 'cad' || !lineItems?.data || lineItems.data.length !== 1) return null;
  const item = lineItems.data[0];
  const unitAmount = item.price?.unit_amount;
  if (item.price?.currency !== 'cad') return null;
  const quantity = item.quantity ?? 1;
  if (quantity !== 1) return null;
  if (unitAmount === 199) return { tier: 'STARTER', maxTickets: 25 };
  if (unitAmount === 299) return { tier: 'STANDARD', maxTickets: 50 };
  if (unitAmount === 499) return { tier: 'MEGA', maxTickets: 100 };
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const signature = req.headers['stripe-signature'];
  if (!signature) return res.status(400).send('Missing Stripe signature');

  let event;
  try {
    const body = await rawBody(req);
    event = getStripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send('Invalid webhook signature');
  }

  const supported = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!supported.includes(event.type)) return res.status(200).json({ received: true, ignored: true });

  try {
    const stripe = getStripe();
    const sessionId = event.data.object.id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return res.status(200).json({ received: true, pending: true });

    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 10 });
    const packageInfo = packageForLineItems(lineItems, session.currency);
    if (!packageInfo) {
      console.error('Unexpected Stripe package/currency:', { sessionId, currency: session.currency, lineItems: lineItems.data?.map(x => ({ amount: x.price?.unit_amount, currency: x.price?.currency })) });
      return res.status(400).send('Unexpected package amount or currency');
    }

    const db = getDb();
    const tokens = db.collection('artifacts').doc(appId()).collection('public').doc('data').collection('tambola_tokens');
    const sessions = db.collection('stripe_payment_sessions');
    const events = db.collection('stripe_webhook_events');
    const token = `HOST-${packageInfo.tier}-${randomBytes(8).toString('hex').toUpperCase()}`;
    const tokenRef = tokens.doc(token);
    const sessionRef = sessions.doc(sessionId);
    const eventRef = events.doc(event.id);

    await db.runTransaction(async tx => {
      const [sessionSnap, eventSnap] = await Promise.all([tx.get(sessionRef), tx.get(eventRef)]);
      if (sessionSnap.exists || eventSnap.exists) return;
      tx.create(tokenRef, {
        token,
        tier: packageInfo.tier,
        maxTickets: packageInfo.maxTickets,
        singleUse: true,
        usedCount: 0,
        active: true,
        status: 'active',
        inUse: false,
        activeRoomCode: null,
        paymentStatus: 'paid',
        currency: 'cad',
        amountPaid: session.amount_total,
        buyerEmail: session.customer_details?.email || session.customer_email || null,
        stripeSessionId: sessionId,
        stripePaymentLink: session.payment_link || null,
        stripeEventId: event.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.create(sessionRef, {
        stripeSessionId: sessionId,
        token,
        tier: packageInfo.tier,
        maxTickets: packageInfo.maxTickets,
        paymentStatus: 'paid',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.create(eventRef, { eventId: event.id, type: event.type, processedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Stripe webhook fulfillment error:', err);
    return res.status(500).send('Webhook fulfillment failed; Stripe may retry this event');
  }
}

// Firebase Admin is loaded lazily by lib/server.js; use the Admin SDK's FieldValue here.
import admin from 'firebase-admin';
