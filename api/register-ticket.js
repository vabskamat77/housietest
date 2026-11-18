
import {
  getDb,
  appId,
  setCors,
  requireMethod,
  verifyFirebaseUser
} from '../lib/server.js';

import { createTicket } from '../lib/tickets.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (!requireMethod(req, res, 'POST')) return;

  let user;

  try {
    user = await verifyFirebaseUser(req);
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: 'Firebase authentication required.'
    });
  }

  const roomCode = String(req.body?.roomCode || '')
    .trim()
    .toUpperCase();

  const playerName = String(req.body?.playerName || '')
    .trim();

  const action = String(req.body?.action || 'join');

  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid Party Code.'
    });
  }

  if (
    !playerName ||
    playerName.length > 80 ||
    /[\u0000-\u001F\u007F]/.test(playerName)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Player name must contain 1 to 80 valid characters.'
    });
  }

  if (!['join', 'add'].includes(action)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid ticket registration action.'
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

    // Server-owned registration record.
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
// Prevent new ticket issuance after the game begins.
const gameHasStarted =
  Array.isArray(room.calledNumbers) &&
  room.calledNumbers.length > 0;

if (gameHasStarted) {
  if (action === 'add' || !registrationSnap.exists) {
    throw new Error(
      'New tickets cannot be issued after the game has started.'
    );
  }
}
      if (
        room.roomClosed === true ||
        room.active !== true ||
        room.status !== 'active'
      ) {
        throw new Error('This Party is not active.');
      }

      const existing = registrationSnap.exists
        ? registrationSnap.data()
        : null;

      const existingTickets = existing?.tickets || [];

      if (!Array.isArray(existingTickets)) {
        throw new Error('Invalid existing registration.');
      }

      // A reconnect returns the existing server-issued tickets.
      if (action === 'join' && existing) {
        return {
          tickets: existingTickets,
          ticketCount: existingTickets.length,
          reconnected: true
        };
      }

      if (room.lockRoomNewPlayers === true && !existing) {
        throw new Error('This Party is locked to new players.');
      }

      if (action === 'add' && !existing) {
        throw new Error('Join the Party before adding tickets.');
      }

      if (
        action === 'add' &&
        room.allowMultiTickets !== true
      ) {
        throw new Error('Multiple tickets are disabled by the Host.');
      }

      if (existingTickets.length >= 4) {
        throw new Error('Maximum four tickets per player.');
      }

      const maxTickets = Number(room.maxRoomTickets);

      if (
        !Number.isSafeInteger(maxTickets) ||
        maxTickets < 1 ||
        maxTickets > 10000
      ) {
        throw new Error('Invalid Party ticket capacity.');
      }

      // Only counts tickets issued through this new backend.
      const issuedCount = Number(room.serverIssuedTicketCount ?? 0);

      if (
        !Number.isSafeInteger(issuedCount) ||
        issuedCount < 0 ||
        issuedCount >= maxTickets
      ) {
        throw new Error('Party ticket capacity reached.');
      }

      const ticketNumber = existingTickets.length + 1;
      const ticket = createTicket(`Ticket ${ticketNumber}`);

      // Store only immutable ticket identity and grid here.
      const issuedTicket = {
        id: ticket.id,
        name: ticket.name,
        grid: ticket.grid
      };

      const updatedTickets = [...existingTickets, issuedTicket];

      if (existing) {
        tx.update(registrationRef, {
          tickets: updatedTickets,
          updatedAt: Date.now()
        });
      } else {
        tx.create(registrationRef, {
          ownerUid: user.uid,
          roomCode,
          playerName,
          tickets: updatedTickets,
          createdAt: Date.now()
        });
      }

      tx.update(roomRef, {
        serverIssuedTicketCount: issuedCount + 1
      });

      return {
        tickets: updatedTickets,
        ticketCount: updatedTickets.length,
        reconnected: false
      };
    });

    // Daub state is UI-only, not authoritative claim evidence.
    const tickets = result.tickets.map(ticket => ({
      ...ticket,
      daubed: Array.from(
        { length: 3 },
        () => Array(9).fill(false)
      )
    }));

    return res.status(200).json({
      ok: true,
      roomCode,
      tickets,
      ticketCount: result.ticketCount,
      reconnected: result.reconnected
    });

  } catch (err) {
    console.error('Ticket registration error:', err);

    const message = err.message || 'Registration failed.';

    const expectedError =
      /not found|not active|locked|disabled|maximum|capacity|join the party|invalid existing|invalid party/i
        .test(message);

    return res.status(expectedError ? 400 : 500).json({
      ok: false,
      error: expectedError
        ? message
        : 'Unable to register ticket. Please try again.'
    });
  }
}
