
import {
  getDb,
  appId,
  setCors,
  requireMethod,
  verifyFirebaseUser
} from '../lib/server.js';

import { randomInt } from 'node:crypto';

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

  const action = String(req.body?.action || 'random');

  const requestedNumber = Number(req.body?.number);

  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Party Code.'
    });
  }

  if (!['random', 'manual', 'undo'].includes(action)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid number-calling action.'
    });
  }

  if (
    action === 'manual' &&
    (!Number.isInteger(requestedNumber) ||
      requestedNumber < 1 ||
      requestedNumber > 90)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Number must be between 1 and 90.'
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

      if (room.hostId !== user.uid) {
        throw new Error('Only the Party Host can call numbers.');
      }

      if (
        room.ticketMode !== 'server' ||
        room.active !== true ||
        room.roomClosed === true ||
        room.status !== 'active'
      ) {
        throw new Error('Party is not active.');
      }

      const calledNumbers = room.calledNumbers;

      if (
        !Array.isArray(calledNumbers) ||
        calledNumbers.length > 90 ||
        calledNumbers.some(
          n => !Number.isInteger(n) || n < 1 || n > 90
        ) ||
        new Set(calledNumbers).size !== calledNumbers.length
      ) {
        throw new Error('Invalid called-number history.');
      }

      const updated = [...calledNumbers];

      let selectedNumber = null;

      if (action === 'undo') {
        if (updated.length === 0) {
          throw new Error('No numbers to undo.');
        }

        // Undo is prohibited after a prize is awarded,
        // preventing a winning claim from losing its basis.
        if (
          Object.values(room.claims || {}).some(
            claim => claim && typeof claim === 'object'
          )
        ) {
          throw new Error(
            'Cannot undo numbers after a prize has been awarded.'
          );
        }

        updated.pop();
        selectedNumber = updated.at(-1) ?? null;

      } else if (action === 'manual') {
        if (updated.includes(requestedNumber)) {
          throw new Error('This number has already been called.');
        }

        updated.push(requestedNumber);
        selectedNumber = requestedNumber;

      } else {
        const remaining = [];

        for (let n = 1; n <= 90; n++) {
          if (!updated.includes(n)) {
            remaining.push(n);
          }
        }

        if (remaining.length === 0) {
          throw new Error('All 90 numbers have been called.');
        }

        selectedNumber = remaining[randomInt(remaining.length)];
        updated.push(selectedNumber);
      }

      tx.update(roomRef, {
        calledNumbers: updated,
        currentNumber: selectedNumber
      });

      return {
        number: selectedNumber,
        calledNumbers: updated
      };
    });

    return res.status(200).json({
      ok: true,
      action,
      ...result
    });

  } catch (err) {
    console.error('Secure number-calling error:', err);

    const message = err.message || 'Number calling failed.';

    const expected =
      /not found|only the party host|not active|invalid called-number|no numbers|cannot undo|already been called|all 90 numbers/i
        .test(message);

    return res.status(expected ? 400 : 500).json({
      ok: false,
      error: expected
        ? message
        : 'Unable to process number-calling request.'
    });
  }
}
