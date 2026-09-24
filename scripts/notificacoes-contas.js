const admin = require("firebase-admin");

const TZ = "America/Sao_Paulo";
const SITE_URL =
  process.env.LEPNEUS_SITE_URL ||
  "https://controle.wwtom.com.br/?open=financeiro";
const MODE = process.env.RUN_MODE || "test";

function fail(message) {
  console.error("ERRO:", message);
  process.exit(1);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  fail("O secret FIREBASE_SERVICE_ACCOUNT não foi encontrado.");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  fail("O secret FIREBASE_SERVICE_ACCOUNT não contém um JSON válido.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

function datePartsInTZ(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const o = {};
  for (const p of parts) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day) };
}

function todayIso() {
  const p = datePartsInTZ();
  return `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function validIso(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function dayNumber(s) {
  if (!validIso(s)) return NaN;
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function daysUntil(due) {
  const a = dayNumber(due);
  const b = dayNumber(todayIso());
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a - b;
}

function money(v) {
  return Number(v || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

async function loadOpenPayables() {
  const metaSnap = await db.doc("controleFinanceiroV2Meta/pagar").get();

  if (!metaSnap.exists) {
    console.log("Meta de Contas a Pagar não encontrada.");
    return [];
  }

  const meta = metaSnap.data() || {};
  const count = Math.max(0, Number(meta.chunkCount || 0));
  const syncId = String(meta.syncId || "");
  const out = [];

  for (let i = 0; i < count; i++) {
    const id = `pagar_${String(i).padStart(3, "0")}`;
    const snap = await db.doc(`controleFinanceiroV2/${id}`).get();

    if (!snap.exists) continue;

    const d = snap.data() || {};
    if (syncId && String(d.syncId || "") !== syncId) continue;

    try {
      const rows = JSON.parse(String(d.json || "[]"));
      if (Array.isArray(rows)) out.push(...rows);
    } catch (e) {
      console.error(`JSON inválido no bloco ${id}:`, e.message);
    }
  }

  return out.filter(
    (x) => Number(x.remaining || 0) > 0 && validIso(x.dueDate)
  );
}

async function loadDevices() {
  const snap = await db
    .collection("controlePushDevices")
    .where("enabled", "==", true)
    .get();

  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((x) => x.token);
}

async function disableBadTokens(batch, responses) {
  const writes = [];

  responses.forEach((r, i) => {
    if (r.success) return;

    const code = String(r.error?.code || "");
    console.log("Falha de token:", code);

    if (
      code.includes("registration-token-not-registered") ||
      code.includes("invalid-registration-token")
    ) {
      writes.push(
        db.doc(`controlePushDevices/${batch[i].id}`).set(
          {
            enabled: false,
            disabledReason: code,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      );
    }
  });

  if (writes.length) await Promise.all(writes);
}

async function sendToDevices(devices, { title, body, tag, kind }) {
  if (!devices.length) {
    console.log("Nenhum celular habilitado para notificações.");
    return;
  }

  for (let i = 0; i < devices.length; i += 500) {
    const batch = devices.slice(i, i + 500);

    const result = await messaging.sendEachForMulticast({
      tokens: batch.map((x) => x.token),
      data: {
        title,
        body,
        tag,
        url: SITE_URL,
        kind,
      },
      webpush: {
        headers: {
          TTL: "86400",
        },
      },
    });

    console.log(
      `Enviadas: ${result.successCount}; falhas: ${result.failureCount}`
    );

    await disableBadTokens(batch, result.responses);
  }
}

async function sendTest(devices) {
  await sendToDevices(devices, {
    title: "Le Pneus • Teste de notificação",
    body: "Teste concluído. Os avisos automáticos estão conectados ao GitHub Actions.",
    tag: `lepneus-teste-${Date.now()}`,
    kind: "test",
  });
}

async function sendMorning(rows, devices) {
  const due3 = rows.filter((x) => daysUntil(x.dueDate) === 3);
  const today = rows.filter((x) => daysUntil(x.dueDate) === 0);

  if (due3.length) {
    const total = due3.reduce(
      (sum, x) => sum + Number(x.remaining || 0),
      0
    );

    await sendToDevices(devices, {
      title: `Le Pneus • ${due3.length} conta(s) vencem em 3 dias`,
      body: `Total ${money(total)}. Abra Contas a Pagar para conferir.`,
      tag: `lepneus-3dias-${todayIso()}`,
      kind: "due3",
    });
  } else {
    console.log("08:00: nenhuma conta vencendo em 3 dias.");
  }

  if (today.length) {
    const total = today.reduce(
      (sum, x) => sum + Number(x.remaining || 0),
      0
    );

    await sendToDevices(devices, {
      title: `Le Pneus • ${today.length} conta(s) vencem hoje`,
      body: `Total ${money(total)}. Aviso das 08:00: confira as notas que precisam ser pagas hoje.`,
      tag: `lepneus-hoje-0800-${todayIso()}`,
      kind: "today0800",
    });
  } else {
    console.log("08:00: nenhuma conta vencendo hoje.");
  }
}

async function sendAfternoon(rows, devices) {
  const today = rows.filter((x) => daysUntil(x.dueDate) === 0);

  if (!today.length) {
    console.log("13:30: nenhuma conta vencendo hoje.");
    return;
  }

  const total = today.reduce(
    (sum, x) => sum + Number(x.remaining || 0),
    0
  );

  await sendToDevices(devices, {
    title: "Le Pneus • Lembrete de contas a pagar",
    body: `${today.length} conta(s) vencem hoje, total ${money(total)}. Lembrete das 13:30 para conferir se já foram pagas.`,
    tag: `lepneus-hoje-1330-${todayIso()}`,
    kind: "today1330",
  });
}

async function main() {
  console.log("Modo:", MODE);
  console.log("Data no Brasil:", todayIso());

  const devices = await loadDevices();
  console.log("Celulares habilitados:", devices.length);

  if (MODE === "test") {
    await sendTest(devices);
    return;
  }

  const rows = await loadOpenPayables();
  console.log("Contas pendentes carregadas:", rows.length);

  if (MODE === "morning") {
    await sendMorning(rows, devices);
    return;
  }

  if (MODE === "afternoon") {
    await sendAfternoon(rows, devices);
    return;
  }

  fail(`Modo desconhecido: ${MODE}`);
}

main()
  .then(() => {
    console.log("Concluído.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Falha:", e);
    process.exit(1);
  });
