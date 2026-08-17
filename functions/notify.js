/* =====================================================================
   Adhkar Challenge — envoi des notifications push au groupe.

   Appelée par l'app (POST) quand quelqu'un lance un défi ou demande une
   dou'a. Le texte du message est composé ICI, jamais envoyé par le client :
   personne ne peut donc faire dire n'importe quoi à l'app.

   Variables d'environnement à définir dans Netlify :
     VAPID_PUBLIC              clé publique VAPID
     VAPID_PRIVATE             clé privée VAPID
     VAPID_SUBJECT             "mailto:ton@email"
     FIREBASE_SERVICE_ACCOUNT  le JSON du compte de service (une seule ligne)
===================================================================== */

const webpush = require("web-push");
const admin = require("firebase-admin");

/* --- initialisation (une seule fois par instance) --- */
let ready = false;
function init() {
  if (ready) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:contact@example.com",
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
  );
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
  }
  ready = true;
}

/* --- textes des notifications (bilingue simplifié : FR) --- */
function compose(type, who, extra, groupName) {
  const title = groupName || "Adhkar Challenge";
  if (type === "challenge") {
    const t = String(extra || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return { title, body: who + " a lancé un défi : " + t + " 📿" };
  }
  if (type === "dua") {
    return { title, body: who + " demande une dou'a au groupe 🤲" };
  }
  if (type === "done") {
    const t = String(extra || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return { title, body: "Objectif atteint ensemble : " + t + " 🎉" };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors(), body: "Method not allowed" };
  }

  try {
    init();
  } catch (e) {
    return json(500, { error: "Configuration incomplète : " + e.message });
  }

  /* 1. authentifier l'appelant avec son jeton Firebase */
  const auth = event.headers.authorization || event.headers.Authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "Jeton manquant" });

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    return json(401, { error: "Jeton invalide" });
  }

  /* 2. lire la demande */
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "JSON invalide" }); }

  const code = String(body.group || "").toUpperCase().slice(0, 10);
  const type = String(body.type || "");
  if (!code || !type) return json(400, { error: "Paramètres manquants" });

  /* 3. vérifier que l'appelant est bien membre du groupe */
  const db = admin.firestore();
  const ref = db.collection("groups").doc(code);
  const snap = await ref.get();
  if (!snap.exists) return json(404, { error: "Groupe introuvable" });

  const data = snap.data() || {};
  const members = data.members || {};
  if (!members[uid]) return json(403, { error: "Non membre de ce groupe" });

  const msg = compose(type, members[uid].name || "Quelqu'un", body.extra, data.name);
  if (!msg) return json(400, { error: "Type inconnu" });

  /* 4. envoyer à tous les membres abonnés, sauf l'auteur */
  const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: type, url: "/" });
  const stale = [];
  let sent = 0;

  await Promise.all(Object.keys(members).map(async (muid) => {
    if (muid === uid) return;
    const sub = members[muid] && members[muid].push;
    if (!sub || !sub.endpoint) return;
    try {
      await webpush.sendNotification(sub, payload, { TTL: 3600 });
      sent++;
    } catch (err) {
      /* abonnement expiré ou révoqué : on le nettoie */
      if (err.statusCode === 404 || err.statusCode === 410) stale.push(muid);
    }
  }));

  if (stale.length) {
    const patch = { members: {} };
    stale.forEach(u => { patch.members[u] = { push: admin.firestore.FieldValue.delete() }; });
    await ref.set(patch, { merge: true }).catch(() => {});
  }

  return json(200, { sent, cleaned: stale.length });
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}
function json(statusCode, obj) {
  return {
    statusCode,
    headers: Object.assign({ "Content-Type": "application/json" }, cors()),
    body: JSON.stringify(obj)
  };
}
