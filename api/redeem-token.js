
import admin from 'firebase-admin';
import {
  getDb, tokenCollection, appId, setCors,
  requireMethod, verifyFirebaseUser
} from '../lib/server.js';

const WINDOW_MS = 48 * 60 * 60 * 1000;
const PRIZES = [
  'Early 5', 'Early 10', 'Top Line',
  'Middle Line', 'Bottom Line', 'Full House'
];

const INITIAL_CLAIMS = Object.fromEntries(
  PRIZES.map(name => [name, null])
);

const INITIAL_PRIZES = Object.fromEntries(
  PRIZES.map(name => [name, true])
);

function millis(value) {
  if (value == null) return null;
  if (typeof value?.toMillis === 'function') {
    return value.toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function failure(message, status = 403) {
  return Object.assign(new Error(message), { status });
}

export default async function handler(req, res) {
  setCors(req, res);
  if (!requireMethod(req, res, 'POST')) return;

  let user;

  try {
    user = await verifyFirebaseUser(req);
  } catch {
    return res.status(401).json({
      ok: false,
      error: 'Firebase login required.'
    });
  }

  const token = String(req.body?.token || '')
    .trim().toUpperCase();

  const roomCode = String(req.body?.roomCode || '')
    .trim().toUpperCase();

  if (
    !/^HOST-[A-Z0-9-]{4,64}$/.test(token) ||
    !/^[A-Z0-9]{6}$/.test(roomCode)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Host Token or Party Code.'
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
      const tokenSnap = await tx.get(tokenRef);
      const roomSnap = await tx.get(roomRef);

      if (!tokenSnap.exists) {
        throw failure('Host Token not found.', 404);
      }

      const data = tokenSnap.data();
      const singleUse = data.singleUse !== false;
      const existingCode = data.activeRoomCode || null;
      const usedCount = Number(data.usedCount) || 0;
      const now = Date.now();

      // An existing active party can be resumed by
      // its original authenticated host, even after
      // the token's 48-hour window has ended.
      if (roomSnap.exists) {
        const room = roomSnap.data();

        if (
          existingCode === roomCode &&
          room.hostId === user.uid &&
          room.roomClosed !== true &&
          room.active === true &&
          room.status === 'active'
        ) {
          return {
            roomCode,
            maxTickets: Number(room.maxRoomTickets) || 50,
            singleUse,
            expiresAt: millis(data.expiresAt)
          };
        }

        throw failure('Party Code already exists.', 409);
      }

      if (
        data.active === false ||
        (data.status && data.status !== 'active')
      ) {
        throw failure('This Host Token is inactive.');
      }

      if (existingCode) {
        throw failure(
          'This Host Token already has an active Party.',
          409
        );
      }

      let firstUsedAtMs = millis(data.firstUsedAt);
      let expiresAtMs = millis(data.expiresAt);

      if (singleUse) {
        // Previously used tokens need migration.
        // Never silently restart their 48-hour clock.
        if (usedCount > 0 && firstUsedAtMs == null) {
          throw failure(
            'Previously used token requires one-time migration of firstUsedAt.',
            409
          );
        }

        if (firstUsedAtMs == null) {
          firstUsedAtMs = now;
        }

        // Expiration is anchored to first use.
        const deadline = firstUsedAtMs + WINDOW_MS;

        expiresAtMs = expiresAtMs == null
          ? deadline
          : Math.min(expiresAtMs, deadline);
      }

      if (
        expiresAtMs != null &&
        now >= expiresAtMs
      ) {
        throw failure('This Host Token has expired.');
      }

      const maxTickets = Number(data.maxTickets) || 50;

      if (
        !Number.isInteger(maxTickets) ||
        maxTickets < 1 ||
        maxTickets > 10000
      ) {
        throw failure(
          'Invalid ticket capacity.',
          400
        );
      }

      // Create the party through Firebase Admin.
      tx.create(roomRef, {
        roomCode,
        hostId: user.uid,
        hostName: 'Host',
        status: 'active',
        active: true,
        roomClosed: false,
        maxRoomTickets: maxTickets,
        serverIssuedTicketCount: 0,
        ticketMode: 'server',
        allowMultiTickets: false,
        calledNumbers: [],
        currentNumber: null,
        restrictOnePrizePerTicket: false,
        lockRoomNewPlayers: false,
        prizesEnabled: { ...INITIAL_PRIZES },
        claims: { ...INITIAL_CLAIMS },
        createdAt: now
      });

      const tokenUpdates = {
        usedCount: usedCount + 1,
        activeRoomCode: roomCode,
        inUse: true,
        lastRedeemedAt:
          admin.firestore.Timestamp.fromMillis(now)
      };

      if (singleUse) {
        tokenUpdates.firstUsedAt =
          admin.firestore.Timestamp.fromMillis(
            firstUsedAtMs
          );

        tokenUpdates.expiresAt =
          admin.firestore.Timestamp.fromMillis(
            expiresAtMs
          );
      }

      tx.update(tokenRef, tokenUpdates);

      return {
        roomCode,
        maxTickets,
        singleUse,
        expiresAt: expiresAtMs
      };
    });

    return res.status(200).json({
      ok: true,
      ...result
    });

  } catch (err) {
    console.error('Party creation failed:', err);

    const status = [400, 403, 404, 409].includes(err.status)
      ? err.status
      : 500;

    return res.status(status).json({
      ok: false,
      error: status === 500
        ? 'Could not create party. Please try again.'
        : err.message
    });
  }
}
