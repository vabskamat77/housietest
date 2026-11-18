import { getDb, tokenCollection } from '../lib/server.js';
import { setCors, requireMethod } from '../lib/server.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (!requireMethod(req, res, 'POST')) return;
  const token = String(req.body?.token || '').trim().toUpperCase();
  const roomCode = String(req.body?.roomCode || '').trim().toUpperCase();
  if (!/^HOST-[A-Z]+-[A-F0-9]{16}$/.test(token) && !/^HOST-[A-Z0-9-]{4,64}$/.test(token)) {
    return res.status(400).json({ ok: false, error: 'Invalid Host Token format.' });
  }
  if (!/^[A-Z0-9]{6}$/.test(roomCode)) return res.status(400).json({ ok: false, error: 'Invalid Party Code.' });

  try {
    const db = getDb();
    const ref = tokenCollection(db).doc(token);
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Host Token not found.');
      const data = snap.data();
      if (data.active === false || (data.status && String(data.status).toLowerCase() !== 'active')) throw new Error('This Host Token is inactive.');
      if (data.expiresAt && data.expiresAt.toMillis && data.expiresAt.toMillis() < Date.now()) throw new Error('This Host Token has expired.');
      const singleUse = data.singleUse !== false;
      if (singleUse) {
        if ((data.usedCount || 0) > 0 && data.activeRoomCode !== roomCode) throw new Error('This single-use Host Token has already been used.');
        if (data.activeRoomCode && data.activeRoomCode !== roomCode) throw new Error('This Host Token is already assigned to another active Party.');
      }
      tx.update(ref, {
        usedCount: (data.usedCount || 0) + (data.activeRoomCode === roomCode ? 0 : 1),
        ...(singleUse ? { activeRoomCode: roomCode, inUse: true } : {}),
        lastRedeemedAt: new Date()
      });
      return { maxTickets: Number(data.maxTickets) || 50, singleUse };
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const message = err.message || 'Token validation failed.';
    const status = /not found|inactive|expired|already used|already assigned/i.test(message) ? 403 : 500;
    console.error('Host token redemption failed:', message);
    return res.status(status).json({ ok: false, error: message });
  }
}
