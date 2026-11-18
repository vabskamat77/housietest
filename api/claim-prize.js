
import {
  getDb,
  appId,
  setCors,
  requireMethod,
  verifyFirebaseUser
} from '../lib/server.js';

import {
  PRIZE_NAMES,
  verifyPrizePattern
} from '../lib/tickets.js';

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
    .trim().toUpperCase();
  const ticketId = String(req.body?.ticketId || '').trim();
  const prizeName = String(req.body?.prizeName || '');

  if (!/^[A-Z0-9]{6}$/.test(roomCode) ||
      !/^TKT-[A-F0-9]{16}$/.test(ticketId) ||
      !PRIZE_NAMES.includes(prizeName)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid prize claim request.'
    });
  }

  try {
    const db = getDb();

    const roomRef = db
      .collection('artifacts').doc(appId())
      .collection('public').doc('data')
      .collection('tambola_rooms').doc(roomCode);

    const registrationRef = roomRef
      .collection('ticket_registrations')
      .doc(user.uid);

    const result = await db.runTransaction(async tx => {
      const roomSnap = await tx.get(roomRef);
      const registrationSnap = await tx.get(registrationRef);

      if (!roomSnap.exists) {
        throw new Error('Party not found.');
      }

      const room = roomSnap.data();

      if (room.ticketMode !== 'server' ||
          room.active !== true ||
          room.roomClosed === true ||
          room.status !== 'active') {
        throw new Error('Party is not active.');
      }

      if (!registrationSnap.exists) {
        throw new Error('No registered tickets found.');
      }

      const registration = registrationSnap.data();

      if (registration.ownerUid !== user.uid) {
        throw new Error('Ticket ownership verification failed.');
      }

      const ticket = (registration.tickets || [])
        .find(t => t.id === ticketId);

      if (!ticket) {
        throw new Error('Ticket not registered to this player.');
      }

      const claims = room.claims || {};

      if (claims[prizeName]) {
        throw new Error('This prize has already been claimed.');
      }

      if (room.prizesEnabled?.[prizeName] !== true) {
        throw new Error('This prize is disabled.');
      }

      if (room.restrictOnePrizePerTicket === true) {
        const alreadyWon = Object.values(claims).some(
          claim => claim && claim.ticketId === ticketId
        );

        if (alreadyWon) {
          throw new Error(
            'This ticket has already won another prize.'
          );
        }
      }

      // Reject malformed or duplicated called-number history.
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

      
      if (!verifyPrizePattern(
        ticket.grid,
        calledNumbers,
        prizeName
      )) {
        throw new Error(
          'The ticket does not satisfy the prize pattern.'
        );
      }

      const claim = {
        winnerName: registration.playerName,
        ticketName: ticket.name,
        ticketId,
        claimedAt: Date.now()
      };

      tx.update(roomRef, {
        [`claims.${prizeName}`]: claim
      });

      return claim;
    });

    return res.status(200).json({
      ok: true,
      prizeName,
      claim: result
    });

  } catch (err) {
    console.error('Prize claim error:', err);

    const message = err.message || 'Claim failed.';

    const expected =
      /not found|not active|ownership|registered|claimed|disabled|already won|does not satisfy|invalid called-number/i
        .test(message);

    return res.status(expected ? 400 : 500).json({
      ok: false,
      error: expected ? message : 'Could not verify prize claim.'
    });
  }
}
