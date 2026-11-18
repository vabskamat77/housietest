
import {
  getDb,
  appId,
  setCors,
  requireMethod,
  verifyFirebaseUser
} from '../lib/server.js';

const PRIZES = new Set([
  'Early 5',
  'Early 10',
  'Top Line',
  'Middle Line',
  'Bottom Line',
  'Full House'
]);

const RULES = new Set([
  'restrictOnePrizePerTicket',
  'allowMultiTickets',
  'lockRoomNewPlayers'
]);

export default async function handler(req, res) {
  setCors(req, res);

  if (!requireMethod(req, res, 'POST')) return;

  // Step 1: Verify Firebase authentication.
  let user;

  try {
    user = await verifyFirebaseUser(req);
  } catch {
    return res.status(401).json({
      ok: false,
      error: 'Firebase authentication required.'
    });
  }

  // Step 2: Validate the incoming request.
  const {
    roomCode,
    setting,
    value,
    prizeName
  } = req.body || {};

  if (
    typeof roomCode !== 'string' ||
    !/^[A-Z0-9]{6}$/.test(roomCode)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid room code.'
    });
  }

  if (
    typeof value !== 'boolean' ||
    !(
      RULES.has(setting) ||
      (
        setting === 'prizesEnabled' &&
        PRIZES.has(prizeName)
      )
    )
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid setting or value.'
    });
  }

  // Step 3: Update Firestore through Firebase Admin.
  try {
    const db = getDb();

    const roomRef = db
      .collection('artifacts')
      .doc(appId())
      .collection('public')
      .doc('data')
      .collection('tambola_rooms')
      .doc(roomCode);

    await db.runTransaction(async tx => {
      const snap = await tx.get(roomRef);

      if (!snap.exists) {
        throw Object.assign(
          new Error('Party not found.'),
          { status: 404 }
        );
      }

      const room = snap.data();

      // Only the authenticated host can change settings.
      if (room.hostId !== user.uid) {
        throw Object.assign(
          new Error('Only the host can update settings.'),
          { status: 403 }
        );
      }

      // Prevent updates to closed or inactive parties.
      if (
        room.roomClosed === true ||
        room.active !== true ||
        room.status !== 'active'
      ) {
        throw Object.assign(
          new Error('Party is not active.'),
          { status: 409 }
        );
      }

      // Step 4: Handle prize availability.
      if (setting === 'prizesEnabled') {

        // A prize already claimed cannot be disabled.
        if (
          room.claims?.[prizeName] &&
          value === false
        ) {
          throw Object.assign(
            new Error(
              'A claimed prize cannot be disabled.'
            ),
            { status: 409 }
          );
        }

        tx.update(roomRef, {
          [`prizesEnabled.${prizeName}`]: value
        });

      } else {

        // Prevent ticket-policy changes after game starts.
        if (
          setting === 'allowMultiTickets' &&
          (room.calledNumbers || []).length > 0
        ) {
          throw Object.assign(
            new Error(
              'Ticket policy is locked after the game starts.'
            ),
            { status: 409 }
          );
        }

        tx.update(roomRef, {
          [setting]: value
        });
      }
    });

    // Step 5: Return successful response.
    return res.status(200).json({
      ok: true,
      setting,
      value,
      ...(
        setting === 'prizesEnabled'
          ? { prizeName }
          : {}
      )
    });

  } catch (err) {
    console.error(
      'Room setting update failed:',
      err
    );

    const status = [403, 404, 409].includes(err.status)
      ? err.status
      : 500;

    return res.status(status).json({
      ok: false,
      error: status === 500
        ? 'Could not update room setting.'
        : err.message
    });
  }
}
