
import {
  getDb,
  appId,
  setCors,
  requireMethod,
  verifyFirebaseUser
} from '../lib/server.js';

export default async function handler(req, res) {
  setCors(req, res);

  if (!requireMethod(req, res, 'POST')) return;

  let user;

  try {
    user = await verifyFirebaseUser(req);
  } catch {
    return res.status(401).json({
      ok: false,
      error: 'Firebase authentication required.'
    });
  }

  const roomCode = String(req.body?.roomCode || '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Party Code.'
    });
  }

  try {
    const db = getDb();

    const roomRef = db
      .collection('artifacts')
      .doc(appId())
      .collection('public')
      .doc('data')
      .collection('tambola_rooms')
      .doc(roomCode);

    const result = await db.runTransaction(async tx => {
      const roomSnap = await tx.get(roomRef);

      if (!roomSnap.exists) {
        throw new Error('Party not found.');
      }

      const room = roomSnap.data();

      // Only the authenticated host may reset the game.
      if (room.hostId !== user.uid) {
        throw new Error(
          'Only the Party Host can reset numbers.'
        );
      }

      if (
        room.ticketMode !== 'server' ||
        room.active !== true ||
        room.roomClosed === true ||
        room.status !== 'active'
      ) {
        throw new Error('Party is not active.');
      }

      // Reset the called numbers and previous winners together.
      tx.update(roomRef, {
        calledNumbers: [],
        currentNumber: null,
        claims: {}
      });

      return {
        calledNumbers: [],
        currentNumber: null,
        claims: {}
      };
    });

    return res.status(200).json({
      ok: true,
      message: 'Numbers and prize claims reset successfully.',
      ...result
    });

  } catch (err) {
    console.error('Secure reset error:', err);

    const message = err.message || 'Reset failed.';

    const expected =
      /not found|only the party host|not active/i
        .test(message);

    return res.status(expected ? 400 : 500).json({
      ok: false,
      error: expected
        ? message
        : 'Unable to reset Party numbers.'
    });
  }
}
