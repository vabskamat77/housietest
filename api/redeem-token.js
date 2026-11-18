
import {
  getDb,
  tokenCollection,
  appId,
  setCors,
  requireMethod,
  verifyFirebaseUser
} from '../lib/server.js';

const INITIAL_CLAIMS = {
  'Early 5': null,
  'Early 10': null,
  'Top Line': null,
  'Middle Line': null,
  'Bottom Line': null,
  'Full House': null
};

const INITIAL_PRIZES = {
  'Early 5': true,
  'Early 10': true,
  'Top Line': true,
  'Middle Line': true,
  'Bottom Line': true,
  'Full House': true
};

export default async function handler(req, res) {
  setCors(req, res);
  if (!requireMethod(req, res, 'POST')) return;

  let user;
  try {
    user = await verifyFirebaseUser(req);
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: 'Firebase login required. Refresh and try again.'
    });
  }

  const token = String(req.body?.token || '')
    .trim().toUpperCase();
  const roomCode = String(req.body?.roomCode || '')
    .trim().toUpperCase();

  if (!/^HOST-[A-Z0-9-]{4,64}$/.test(token)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Host Token format.'
    });
  }

  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Party Code.'
    });
  }

  try {
    const db = getDb();
    const tokenRef = tokenCollection(db).doc(token);
    const roomRef = db.collection('artifacts')
      .doc(appId())
      .collection('public')
      .doc('data')
      .collection('tambola_rooms')
      .doc(roomCode);

    const result = await db.runTransaction(async tx => {
      // All transaction reads must happen before writes.
      const tokenSnap = await tx.get(tokenRef);
      const roomSnap = await tx.get(roomRef);

      if (!tokenSnap.exists) {
        throw new Error('Host Token not found.');
      }

      const data = tokenSnap.data();

      if (
        data.active === false ||
        (data.status &&
          String(data.status).toLowerCase() !== 'active')
      ) {
        throw new Error('This Host Token is inactive.');
      }

      if (
        data.expiresAt?.toMillis &&
        data.expiresAt.toMillis() < Date.now()
      ) {
        throw new Error('This Host Token has expired.');
      }

      const singleUse = data.singleUse !== false;
      const existingCode = data.activeRoomCode || null;
      const usedCount = Number(data.usedCount) || 0;

      // Idempotent retry for a room already created by
      // this token and this authenticated host.
      if (roomSnap.exists) {
        const room = roomSnap.data();

        if (
          room.hostId === user.uid &&
          tokenSnap.data().activeRoomCode === roomCode &&
          existingCode === roomCode &&
          room.roomClosed !== true &&
          room.active !== false &&
          room.status === 'active'
        ) {
          return {
            roomCode,
            maxTickets: Number(room.maxRoomTickets) || 50,
            singleUse
          };
        }

        throw new Error('Party Code already exists.');
      }

      if (singleUse && (usedCount > 0 || existingCode)) {
        throw new Error(
          'This single-use Host Token has already been used.'
        );
      }

      if (existingCode) {
        throw new Error(
          'This Host Token is already assigned to another Party.'
        );
      }

      const maxTickets = Number(data.maxTickets) || 50;

      if (
        !Number.isInteger(maxTickets) ||
        maxTickets < 1 ||
        maxTickets > 10000
      ) {
        throw new Error('Invalid ticket capacity.');
      }

      const roomData = {
        roomCode,
        hostId: user.uid,
        hostName: 'Host',
        status: 'active',
        active: true,
        roomClosed: false,
        maxRoomTickets: maxTickets,
        calledNumbers: [],
        currentNumber: null,
        restrictOnePrizePerTicket: false,
        lockRoomNewPlayers: false,
        prizesEnabled: { ...INITIAL_PRIZES },
        claims: { ...INITIAL_CLAIMS },
        createdAt: Date.now()
      };

      tx.create(roomRef, roomData);

      tx.update(tokenRef, {
        usedCount: usedCount + 1,
        ...(singleUse
          ? { activeRoomCode: roomCode, inUse: true }
          : {}),
        lastRedeemedAt: new Date()
      });

      return { roomCode, maxTickets, singleUse };
    });

    return res.status(200).json({
      ok: true,
      ...result
    });
  } catch (err) {
    console.error('Party creation failed:', err);

    const message = err.message || 'Party creation failed.';

    const clientError =
      /not found|inactive|expired|already|invalid/i.test(message);

    return res.status(clientError ? 403 : 500).json({
      ok: false,
      error: clientError
        ? message
        : 'Could not create party. Please try again.'
    });
  }
}
