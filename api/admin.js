import { randomBytes } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, appId } from '../lib/server.js';

const allowedOrigins = (process.env.ADMIN_ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const allowedUids = (process.env.ADMIN_UIDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const limits = new Set([10,25,50,100]);
const tokenPattern = /^HOST-[A-Z0-9-]{4,60}$/;
const roomPattern = /^[A-Z0-9]{6}$/;
const tokens = db => db.collection('artifacts').doc(appId()).collection('public').doc('data').collection('tambola_tokens');
const rooms = db => db.collection('artifacts').doc(appId()).collection('public').doc('data').collection('tambola_rooms');
const stamp = () => FieldValue.serverTimestamp();
function send(res, status, data) { return res.status(status).json(data); }
function audit(db, uid, action, target, detail={}) {
  return db.collection('admin_audit_logs').add({uid, action, target, detail, at:stamp()});
}
function serialize(d) {
  const x=d.data();
  const norm=v=>v && typeof v.toMillis==='function' ? v.toMillis() : v;
  return {id:d.id,...Object.fromEntries(Object.entries(x).map(([k,v])=>[k,norm(v)]))};
}
export default async function handler(req,res) {
  const origin=req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  }
  res.setHeader('Cache-Control','no-store');
  if (req.method==='OPTIONS') return res.status(origin && allowedOrigins.includes(origin)?204:403).end();
  if (origin && !allowedOrigins.includes(origin)) return send(res,403,{error:'Origin not allowed'});
  if (!['GET','POST'].includes(req.method)) return send(res,405,{error:'Method not allowed'});
  if (!allowedUids.length || !allowedOrigins.length) return send(res,503,{error:'Admin API is not configured'});
  const match=/^Bearer (.+)$/.exec(req.headers.authorization||'');
  if (!match) return send(res,401,{error:'Sign in required'});
  let identity;
  
try {
  

getDb(); // Initialize Firebase Admin if needed.

const { getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');

const firebaseApp = getApps()[0];

if (!firebaseApp) {
  throw new Error('Firebase Admin app was not initialized.');
}

identity = await getAuth(firebaseApp)
  .verifyIdToken(match[1], true);


} catch (err) {
  console.error('Admin Firebase token verification failed:', {
    code: err.code || 'unknown',
    message: err.message || 'Unknown authentication error'
  });

  return send(res, 401, {
    error: 'Admin login verification failed. Check Vercel logs.',
    code: err.code || 'unknown'
  });
}

  if (!allowedUids.includes(identity.uid) || identity.firebase?.sign_in_provider==='anonymous') return send(res,403,{error:'Administrator access denied'});
  const db=getDb();
  try {
    if (req.method==='GET') {
      const [t,r,s]=await Promise.all([
        tokens(db).orderBy('createdAt','desc').limit(200).get(),
        rooms(db).limit(300).get(),
        db.collection('stripe_payment_sessions').orderBy('createdAt','desc').limit(100).get()
      ]);
      return send(res,200,{tokens:t.docs.map(serialize).filter(x=>x.hiddenFromAdmin!==true),rooms:r.docs.map(serialize).filter(x=>!x.roomClosed),sessions:s.docs.map(serialize)});
    }
    const body=req.body||{};
    const action=body.action;
    if (action==='create-token') {
      const maxTickets=Number(body.maxTickets);
      if (!limits.has(maxTickets)) return send(res,400,{error:'Invalid capacity'});
      const singleUse=body.singleUse!==false;
      const custom=body.token ? String(body.token).trim().toUpperCase() : null;
      if (custom && !tokenPattern.test(custom)) return send(res,400,{error:'Custom token must be HOST- followed by 4–60 letters, numbers or hyphens'});
      const token=custom||`HOST-ADMIN-${randomBytes(12).toString('hex').toUpperCase()}`;
      await tokens(db).doc(token).create({token,tier:'ADMIN',maxTickets,singleUse,usedCount:0,active:true,status:'active',inUse:false,activeRoomCode:null,source:'admin',createdBy:identity.uid,createdAt:stamp()});
      await audit(db,identity.uid,action,token,{maxTickets,singleUse});
      return send(res,201,{ok:true,token});
    }
    
if (action === 'remove-token') {
  const token = String(body.token || '')
    .trim()
    .toUpperCase();

  if (!tokenPattern.test(token)) {
    return send(res, 400, {
      error: 'Invalid token'
    });
  }

  const tokenRef = tokens(db).doc(token);

  await db.runTransaction(async tx => {
    const tokenSnap = await tx.get(tokenRef);

    if (!tokenSnap.exists) {
      throw Object.assign(
        new Error('Token not found'),
        { status: 404 }
      );
    }

    const tokenData = tokenSnap.data();
    const roomCode = tokenData.activeRoomCode;

    // Check actual room status, not just the
    // token's possibly outdated inUse flag.
    if (roomCode) {
      const roomRef = rooms(db).doc(roomCode);
      const roomSnap = await tx.get(roomRef);

      if (roomSnap.exists) {
        const room = roomSnap.data();

        const isActive =
          room.roomClosed !== true &&
          room.active === true &&
          room.status === 'active';

        if (isActive) {
          throw Object.assign(
            new Error(
              'This token still has an active party. ' +
              'Close the party before removing it.'
            ),
            { status: 409 }
          );
        }
      }
    }

    // No active party remains.
    // Clear stale token associations and archive.
    tx.update(tokenRef, {
      activeRoomCode: null,
      inUse: false,
      hiddenFromAdmin: true,
      active: false,
      status: 'revoked',
      removedAt: stamp(),
      removedBy: identity.uid
    });
  });

  await audit(db, identity.uid, action, token);

  return send(res, 200, {
    ok: true,
    message: 'Host Token removed from Admin Portal.'
  });
}

    if (action==='revoke-token' || action==='activate-token') {
      const token=String(body.token||'').toUpperCase();
      if (!tokenPattern.test(token)) return send(res,400,{error:'Invalid token'});
      const ref=tokens(db).doc(token);
      await db.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        if (!snap.exists) throw Object.assign(new Error('Token not found'),{status:404});
        const x=snap.data();
        if (action==='activate-token' && (x.usedCount>0 || x.inUse || x.activeRoomCode)) throw Object.assign(new Error('Used or reserved tokens cannot be reactivated'),{status:409});
        tx.update(ref,action==='revoke-token'?{active:false,status:'revoked',revokedAt:stamp(),revokedBy:identity.uid}:{active:true,status:'active',reactivatedAt:stamp(),reactivatedBy:identity.uid});
      });
      await audit(db,identity.uid,action,token);
      return send(res,200,{ok:true});
    }
    if (action==='close-party' || action==='close-all-parties') {
      const selected=[];
      if (action==='close-party') {
        const code=String(body.roomCode||'').toUpperCase();
        if (!roomPattern.test(code)) return send(res,400,{error:'Invalid party code'});
        selected.push(code);
      } else {
        const snapshot=await rooms(db).where('roomClosed','==',false).limit(300).get();
        selected.push(...snapshot.docs.map(d=>d.id));
      }
      let closed=0;
      for (const code of selected) {
        const ref=rooms(db).doc(code);
        const linked=await tokens(db).where('activeRoomCode','==',code).limit(2).get();
        if (linked.size!==1) throw Object.assign(new Error('Party token association could not be verified for '+code),{status:409});
        const linkedTokenRef=linked.docs[0].ref;
        await db.runTransaction(async tx=>{
          const snap=await tx.get(ref);
          if (!snap.exists || snap.data().roomClosed) return;
          const room=snap.data();
          const tref=linkedTokenRef;
          const tsnap=tref ? await tx.get(tref) : null;
          tx.update(ref,{roomClosed:true,active:false,status:'inactive',closedAt:Date.now(),closedBy:'admin',endedByAdmin:true});
          if (tsnap?.exists && tsnap.data().activeRoomCode===code) {
            tx.update(tref,{inUse:false,activeRoomCode:null});
          }
          closed++;
        });
      }
      await audit(db,identity.uid,action,action==='close-party'?selected[0]:'all',{closed});
      return send(res,200,{ok:true,closed,remainingMayExist:action==='close-all-parties'&&selected.length===300});
    }
    return send(res,400,{error:'Unknown action'});
  } catch(e) {
    console.error('Admin API failure:',e);
    return send(res,e.status||500,{error:e.status?e.message:'Operation failed; check server logs'});
  }
}
