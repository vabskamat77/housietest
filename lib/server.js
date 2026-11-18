import admin from 'firebase-admin';
import Stripe from 'stripe';

let adminApp;
export function getDb() {
  if (!adminApp) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
    const serviceAccount = JSON.parse(raw);
    adminApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore(adminApp);
}

let stripeClient;
export function getStripe() {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

export function appId() {
  return process.env.FIRESTORE_APP_ID || 'housie';
}

export function setCors(req, res) {
  const allowed = process.env.FRONTEND_ORIGIN || '*';
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', allowed === '*' ? '*' : (origin === allowed ? allowed : 'null'));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

export function requireMethod(req, res, method) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return false; }
  if (req.method !== method) { res.status(405).json({ error: 'Method not allowed' }); return false; }
  return true;
}

export function tokenCollection(db) {
  return db.collection('artifacts').doc(appId()).collection('public').doc('data').collection('tambola_tokens');
}
