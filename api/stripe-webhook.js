
import { randomBytes } from 'node:crypto';
import admin from 'firebase-admin';
import { getDb, getStripe, appId } from '../lib/server.js';
import { sendHostTokenEmail } from '../lib/email.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function packageForLineItems(lineItems, currency) {
  if (
    currency !== 'cad' ||
    lineItems?.has_more ||
    lineItems?.data?.length !== 1
  ) return null;

  const item = lineItems.data[0];

  if (
    item.price?.currency !== 'cad' ||
    (item.quantity ?? 1) !== 1
  ) return null;

  const prices = {
    199: { tier: 'STARTER', maxTickets: 25 },
    299: { tier: 'STANDARD', maxTickets: 50 },
    499: { tier: 'MEGA', maxTickets: 100 }
  };

  return prices[item.price?.unit_amount] || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;

  try {
    event = getStripe().webhooks.constructEvent(
      await rawBody(req),
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(
      'Stripe webhook signature verification failed:',
      err.message
    );

    return res.status(400).send('Invalid webhook signature');
  }

  const supportedEvents = [
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded'
  ];

  if (!supportedEvents.includes(event.type)) {
    return res.status(200).json({
      received: true,
      ignored: true
    });
  }

  try {
    const stripe = getStripe();
    const sessionId = event.data.object.id;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(200).json({
        received: true,
        pending: true
      });
    }

    const lineItems = await stripe.checkout.sessions.listLineItems(
      sessionId,
      { limit: 10 }
    );

    const pkg = packageForLineItems(lineItems, session.currency);

    if (!pkg || !Number.isInteger(session.amount_total)) {
      console.error(
        'Unexpected Stripe package/currency for session:',
        sessionId
      );

      return res.status(400).send(
        'Unexpected package amount or currency'
      );
    }

    const db = getDb();

    const sessionRef = db
      .collection('stripe_payment_sessions')
      .doc(sessionId);

    const eventRef = db
      .collection('stripe_webhook_events')
      .doc(event.id);

    const token = `HOST-${pkg.tier}-${
      randomBytes(8).toString('hex').toUpperCase()
    }`;

    const tokenRef = db
      .collection('artifacts')
      .doc(appId())
      .collection('public')
      .doc('data')
      .collection('tambola_tokens')
      .doc(token);

    const buyerEmail =
      session.customer_details?.email ||
      session.customer_email ||
      null;

    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // Create the Host Token only once per Stripe session.
    await db.runTransaction(async tx => {
      const [sessionSnap, eventSnap] = await Promise.all([
        tx.get(sessionRef),
        tx.get(eventRef)
      ]);

      if (!sessionSnap.exists) {
        tx.create(tokenRef, {
          token,
          tier: pkg.tier,
          maxTickets: pkg.maxTickets,
          singleUse: true,
          usedCount: 0,
          active: true,
          status: 'active',
          inUse: false,
          activeRoomCode: null,
          source: 'stripe',
          paymentStatus: 'paid',
          currency: 'cad',
          amountPaid: session.amount_total,
          buyerEmail,
          stripeSessionId: sessionId,
          stripePaymentLink: session.payment_link || null,
          stripeEventId: event.id,
          createdAt: timestamp
        });

        tx.create(sessionRef, {
          stripeSessionId: sessionId,
          token,
          tier: pkg.tier,
          maxTickets: pkg.maxTickets,
          paymentStatus: 'paid',
          buyerEmail,
          amountPaid: session.amount_total,
          emailStatus: 'pending',
          createdAt: timestamp
        });
      }

      if (!eventSnap.exists) {
        tx.create(eventRef, {
          eventId: event.id,
          type: event.type,
          processedAt: timestamp
        });
      }
    });

    // Atomically claim the email once. Never automatically resubmit an
    // uncertain delivery: Resend may have accepted it before a timeout.
    const claim = await db.runTransaction(async tx => {
      const snap = await tx.get(sessionRef);
      const saved = snap.data();

      if (!saved?.token) {
        throw new Error('Paid session has no saved Host Token');
      }

      if (saved.emailStatus === 'sent') {
        return { status: 'already_sent' };
      }

      if (
        [
          'sending',
          'needs_review',
          'failed',
          'missing_buyer_email'
        ].includes(saved.emailStatus)
      ) {
        return { status: saved.emailStatus };
      }

      // Old records with an email attempt but no definitive status
      // must not be automatically retried.
      if (saved.emailAttemptId || saved.emailLastAttemptAt) {
        tx.update(sessionRef, {
          emailStatus: 'needs_review'
        });

        return { status: 'needs_review' };
      }

      const recipient = saved.buyerEmail || buyerEmail;

      if (!recipient) {
        tx.update(sessionRef, {
          emailStatus: 'missing_buyer_email'
        });

        return { status: 'missing_buyer_email' };
      }

      const payload = {
        sessionId,
        buyerEmail: recipient,
        token: saved.token,
        tier: saved.tier || pkg.tier,
        maxTickets: saved.maxTickets || pkg.maxTickets,
        amountPaid: Number.isInteger(saved.amountPaid)
          ? saved.amountPaid
          : session.amount_total
      };

      // Freeze the complete payload before contacting the email provider.
      tx.update(sessionRef, {
        emailStatus: 'sending',
        emailPayload: payload,
        emailAttemptId: event.id,
        emailLastAttemptAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

      return { status: 'claimed', payload };
    });

    if (claim.status !== 'claimed') {
      return res.status(200).json({
        received: true,
        email: claim.status
      });
    }

    try {
      const { emailId } = await sendHostTokenEmail(claim.payload);

      await sessionRef.update({
        emailStatus: 'sent',
        resendEmailId: emailId,
        emailSentAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(200).json({
        received: true,
        email: 'sent'
      });

    } catch (emailErr) {
      console.error(
        'Host Token email outcome requires review:',
        sessionId,
        emailErr
      );

      // The email may already have been accepted by Resend.
      // Do not automatically send another copy.
      try {
        await sessionRef.update({
          emailStatus: 'needs_review',
          emailError: String(
            emailErr?.message || emailErr
          ).slice(0, 500),
          emailLastAttemptAt:
            admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (recordErr) {
        console.error(
          'Could not record email review status:',
          sessionId,
          recordErr
        );
      }

      return res.status(200).json({
        received: true,
        email: 'needs_review'
      });
    }

  } catch (err) {
    console.error(
      'Stripe webhook fulfillment error:',
      err
    );

    return res.status(500).send(
      'Webhook fulfillment failed; Stripe may retry this event'
    );
  }
}
