
import {
  getDb,
  tokenCollection,
  appId,
  setCors,
  requireMethod,
  verifyFirebaseUser
} from '../lib/server.js';

export default async function handler(req, res) {
  setCors(req, res);

  if (!requireMethod(req, res, 'POST')) return;

  try {
    const user = await verifyFirebaseUser(req);

    const roomCode = String(req.body?.roomCode || '')
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid Party Code.'
      });
    }

    const db = getDb();

    const roomRef = db.collection('artifacts')
      .doc(appId())
      .collection('public')
      .doc('data')
      .collection('tambola_rooms')
      .doc(roomCode);

    // Locate the token associated with this party.
    const tokenMatches = await tokenCollection(db)
      .where('activeRoomCode', '==', roomCode)
      .limit(2)
      .get();

    if (tokenMatches.size !== 1) {
      return res.status(409).json({
        ok: false,
        error:
          'Party token association could not be verified.'
      });
    }

    const tokenRef = tokenMatches.docs[0].ref;

    const result = await db.runTransaction(async tx => {
      const roomSnap = await tx.get(roomRef);
      const tokenSnap = await tx.get(tokenRef);

      if (!roomSnap.exists) {
        throw new Error('Party not found.');
      }

      const room = roomSnap.data();

      // Only the authenticated host may close the party.
      if (room.hostId !== user.uid) {
        throw new Error(
          'Not authorized to close this Party.'
        );
      }

      if (
        room.roomClosed === true ||
        room.active === false
      ) {
        return { alreadyClosed: true };
      }

      if (
        !tokenSnap.exists ||
        tokenSnap.data().activeRoomCode !== roomCode
      ) {
        throw new Error(
          'Party token association changed.'
        );
      }

      // Close the room.
      tx.update(roomRef, {
        roomClosed: true,
        active: false,
        status: 'inactive',
        closedAt: Date.now(),
        closedBy: user.uid
      });

      // Release token for another party.
      // Preserve firstUsedAt and expiresAt.
      tx.update(tokenRef, {
        inUse: false,
        activeRoomCode: null
      });

      return { alreadyClosed: false };
    });

    return res.status(200).json({
      ok: true,
      roomCode,
      ...result
    });

  } catch (err) {
    console.error('Close Party error:', err);

    const message = err.message ||
      'Could not close Party.';

    const status =
      /not authorized/i.test(message) ? 403 :
      /not found/i.test(message) ? 404 :
      /association changed/i.test(message) ? 409 :
      500;

    return res.status(status).json({
      ok: false,
      error: status === 500
        ? 'Could not close Party.'
        : message
    });
  }
}
