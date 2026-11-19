
import { randomBytes } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, appId } from '../lib/server.js';

const allowedOrigins = (process.env.ADMIN_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const allowedUids = (process.env.ADMIN_UIDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const limits = new Set([10, 25, 50, 100]);
const tokenPattern = /^HOST-[A-Z0-9-]{4,60}$/;
const roomPattern = /^[A-Z0-9]{6}$/;

const tokens = db => db.collection('artifacts')
  .doc(appId()).collection('public').doc('data')
  .collection('tambola_tokens');

const rooms = db => db.collection('artifacts')
  .doc(appId()).collection('public').doc('data')
  .collection('tambola_rooms');

const stamp = () => FieldValue.serverTimestamp();

function send(res, status, data) {
  return res.status(status).json(data);
}

function audit(db, uid, action, target, detail = {}) {
  return db.collection('admin_audit_logs').add({
    uid, action, target, detail, at: stamp()
  });
}

function serialize(d) {
  const x = d.data();
  const norm = v => v && typeof v.toMillis === 'function'
    ? v.toMillis() : v;

  return {
    id: d.id,
    ...Object.fromEntries(
      Object.entries(x).map(([k, v]) => [k, norm(v)])
    )
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers',
      'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods',
      'GET, POST, OPTIONS');
  }

  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(
      origin && allowedOrigins.includes(origin) ? 204 : 403
    ).end();
  }

  if (origin && !allowedOrigins.includes(origin)) {
    return send(res, 403, { error: 'Origin not allowed' });
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (!allowedUids.length || !allowedOrigins.length) {
    return send(res, 503, {
      error: 'Admin API is not configured'
    });
  }

  const match = /^Bearer (.+)$/.exec(
    req.headers.authorization || ''
  );

  if (!match) {
    return send(res, 401, { error: 'Sign in required' });
  }

  let identity;

  try {
    getDb();

    const { getApps } = await import('firebase-admin/app');
    const app = getApps()[0];

    if (!app) {
      throw new Error('Firebase Admin app was not initialized.');
    }

    identity = await getAuth(app)
      .verifyIdToken(match[1], true);

  } catch (err) {
    console.error(
      'Admin Firebase token verification failed:',
      err.code || 'unknown',
      err.message
    );

    return send(res, 401, {
      error: 'Admin login verification failed. Check Vercel logs.'
    });
  }

  if (
    !allowedUids.includes(identity.uid) ||
    identity.firebase?.sign_in_provider === 'anonymous'
  ) {
    return send(res, 403, {
      error: 'Administrator access denied'
    });
  }

  const db = getDb();

  try {
    if (req.method === 'GET') {

      // Retrieve all tokens, including older active/in-use tokens.
      async function allDocs(query, pageSize = 400) {
        const result = [];
        let cursor = null;

        while (true) {
          let page = query.limit(pageSize);

          if (cursor) {
            page = page.startAfter(cursor);
          }

          const snapshot = await page.get();
          result.push(...snapshot.docs);

          if (snapshot.size < pageSize) break;

          cursor = snapshot.docs[snapshot.docs.length - 1];
        }

        return result;
      }

      const [tokenDocs, roomDocs, s] = await Promise.all([
        allDocs(tokens(db).orderBy('__name__')),
        allDocs(rooms(db).orderBy('__name__')),
        db.collection('stripe_payment_sessions')
          .orderBy('createdAt', 'desc')
          .limit(100).get()
      ]);

      const allTokens = tokenDocs.map(serialize);
      const allRooms = roomDocs.map(serialize);

      const liveRooms = allRooms.filter(x =>
        x.roomClosed !== true &&
        x.active !== false &&
        x.status !== 'inactive' &&
        x.status !== 'closed'
      );

      const liveCodes = new Set(
        liveRooms.map(x => x.roomCode || x.id)
      );

      // Never hide active or in-use tokens.
      const visible = allTokens.filter(x =>
        x.hiddenFromAdmin !== true ||
        x.active === true ||
        x.inUse === true ||
        liveCodes.has(x.activeRoomCode)
      );

      const now = Date.now();

      const expiryMs = t => {
        const v = t.expiresAt;

        return typeof v === 'number'
          ? v
          : (v?.seconds ? v.seconds * 1000 : 0);
      };

      const isExpired = t =>
        t.singleUse !== false &&
        expiryMs(t) > 0 &&
        expiryMs(t) <= now;

      const inUse = t =>
        t.inUse === true ||
        liveCodes.has(t.activeRoomCode);

      const summary = {
        totalTokens: visible.length,
        activeTokens: visible.filter(
          t => t.active === true
        ).length,
        inUseTokens: visible.filter(inUse).length,
        inactiveTokens: visible.filter(
          t => t.active === false && !inUse(t)
        ).length,
        expiredTokens: visible.filter(isExpired).length,
        availableTokens: visible.filter(
          t => t.active === true &&
               !inUse(t) &&
               !isExpired(t)
        ).length,
        activeParties: liveRooms.length,
        singleUseTokens: visible.filter(
          t => t.singleUse !== false
        ).length,
        multiUseTokens: visible.filter(
          t => t.singleUse === false
        ).length
      };

      return send(res, 200, {
        tokens: visible,
        rooms: liveRooms,
        sessions: s.docs.map(serialize),
        summary
      });
    }

    const body = req.body || {};
    const action = body.action;

    // Generate administrator-issued Host Token.
    if (action === 'create-token') {
      const maxTickets = Number(body.maxTickets);

      if (!limits.has(maxTickets)) {
        return send(res, 400, {
          error: 'Invalid capacity'
        });
      }

      const singleUse = body.singleUse !== false;
      const custom = body.token
        ? String(body.token).trim().toUpperCase()
        : null;

      if (custom && !tokenPattern.test(custom)) {
        return send(res, 400, {
          error: 'Custom token must be HOST- followed by 4–60 letters, numbers or hyphens'
        });
      }

      const token = custom ||
        `HOST-ADMIN-${randomBytes(12).toString('hex').toUpperCase()}`;

      await tokens(db).doc(token).create({
        token,
        tier: 'ADMIN',
        maxTickets,
        singleUse,
        usedCount: 0,
        active: true,
        status: 'active',
        inUse: false,
        activeRoomCode: null,
        source: 'admin',
        createdBy: identity.uid,
        createdAt: stamp()
      });

      await audit(db, identity.uid, action, token, {
        maxTickets, singleUse
      });

      return send(res, 201, { ok: true, token });
    }

    // Remove only inactive tokens without running parties.
    if (action === 'remove-token') {
      const token = String(body.token || '')
        .trim().toUpperCase();

      if (!tokenPattern.test(token)) {
        return send(res, 400, {
          error: 'Invalid token'
        });
      }

      const ref = tokens(db).doc(token);

      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);

        if (!snap.exists) {
          throw Object.assign(
            new Error('Token not found'),
            { status: 404 }
          );
        }

        const x = snap.data();

        if (x.hiddenFromAdmin === true) {
          throw Object.assign(
            new Error('Token already archived'),
            { status: 409 }
          );
        }

        // Active tokens cannot be removed.
        if (x.active !== false) {
          throw Object.assign(
            new Error(
              'Deactivate (revoke) this token before removing it.'
            ),
            { status: 409 }
          );
        }

        if (x.inUse === true && !x.activeRoomCode) {
          throw Object.assign(
            new Error(
              'Token is marked in use without a linked room. Reconcile its state before removing it.'
            ),
            { status: 409 }
          );
        }

        if (x.activeRoomCode) {
          const roomSnap = await tx.get(
            rooms(db).doc(x.activeRoomCode)
          );

          if (roomSnap.exists) {
            const room = roomSnap.data();

            const stillLive =
              room.roomClosed !== true &&
              room.active !== false &&
              room.status !== 'inactive' &&
              room.status !== 'closed';

            if (stillLive) {
              throw Object.assign(
                new Error(
                  'Close the active party before removing this token.'
                ),
                { status: 409 }
              );
            }
          }
        }

        // Archive, rather than permanently delete.
        tx.update(ref, {
          active: false,
          status: 'revoked',
          inUse: false,
          activeRoomCode: null,
          hiddenFromAdmin: true,
          removedAt: stamp(),
          removedBy: identity.uid
        });
      });

      await audit(db, identity.uid, action, token);

      return send(res, 200, {
        ok: true,
        message: 'Inactive Host Token archived.'
      });
    }

    // Revoke or reactivate Host Token.
    if (
      action === 'revoke-token' ||
      action === 'activate-token'
    ) {
      const token = String(body.token || '').toUpperCase();

      if (!tokenPattern.test(token)) {
        return send(res, 400, {
          error: 'Invalid token'
        });
      }

      const ref = tokens(db).doc(token);

      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);

        if (!snap.exists) {
          throw Object.assign(
            new Error('Token not found'),
            { status: 404 }
          );
        }

        const x = snap.data();

        if (
          action === 'activate-token' &&
          (x.usedCount > 0 || x.inUse || x.activeRoomCode)
        ) {
          throw Object.assign(
            new Error(
              'Used or reserved tokens cannot be reactivated'
            ),
            { status: 409 }
          );
        }

        tx.update(
          ref,
          action === 'revoke-token'
            ? {
                active: false,
                status: 'revoked',
                revokedAt: stamp(),
                revokedBy: identity.uid
              }
            : {
                active: true,
                status: 'active',
                reactivatedAt: stamp(),
                reactivatedBy: identity.uid
              }
        );
      });

      await audit(db, identity.uid, action, token);

      return send(res, 200, { ok: true });
    }

    // Close one or all active parties.
    if (
      action === 'close-party' ||
      action === 'close-all-parties'
    ) {
      const selected = [];

      if (action === 'close-party') {
        const code = String(body.roomCode || '').toUpperCase();

        if (!roomPattern.test(code)) {
          return send(res, 400, {
            error: 'Invalid party code'
          });
        }

        selected.push(code);
      } else {
        const snapshot = await rooms(db)
          .where('roomClosed', '==', false)
          .limit(300).get();

        selected.push(...snapshot.docs.map(d => d.id));
      }

      let closed = 0;

      for (const code of selected) {
        const ref = rooms(db).doc(code);

        const linked = await tokens(db)
          .where('activeRoomCode', '==', code)
          .limit(2).get();

        if (linked.size !== 1) {
          throw Object.assign(
            new Error(
              'Party token association could not be verified for ' + code
            ),
            { status: 409 }
          );
        }

        const linkedTokenRef = linked.docs[0].ref;

        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);

          if (!snap.exists || snap.data().roomClosed) return;

          const tsnap = await tx.get(linkedTokenRef);

          tx.update(ref, {
            roomClosed: true,
            active: false,
            status: 'inactive',
            closedAt: Date.now(),
            closedBy: 'admin',
            endedByAdmin: true
          });

          if (
            tsnap?.exists &&
            tsnap.data().activeRoomCode === code
          ) {
            tx.update(linkedTokenRef, {
              inUse: false,
              activeRoomCode: null
            });
          }

          closed++;
        });
      }

      await audit(
        db,
        identity.uid,
        action,
        action === 'close-party' ? selected[0] : 'all',
        { closed }
      );

      return send(res, 200, {
        ok: true,
        closed,
        remainingMayExist:
          action === 'close-all-parties' &&
          selected.length === 300
      });
    }

    return send(res, 400, {
      error: 'Unknown action'
    });

  } catch (e) {
    console.error('Admin API failure:', e);

    return send(res, e.status || 500, {
      error: e.status
        ? e.message
        : 'Operation failed; check server logs'
    });
  }
}
