// notifications.js
// Handles browser notifications + Telegram alerts

const TELEGRAM_TOKEN = "8336283112:AAEAqH27-GAULHPv--mDUg5Z1wu6MAggy4k";
const TELEGRAM_CHAT_ID = "673358197";

// ── Browser Notifications ─────────────────────────────────────────────────

export async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function scheduleNotification(task) {
  if (!task.datetime || task.done) return;
  const due = new Date(task.datetime);
  const now = new Date();
  const ms = due - now;
  if (ms <= 0) return;

  // Schedule browser notification
  const timerId = setTimeout(() => {
    if (Notification.permission === "granted") {
      new Notification("⏰ " + task.title, {
        body: task.notes ? task.notes : `Tarea vence ahora`,
        icon: "/favicon.ico",
        tag: "task-" + task.id,
      });
    }
    // Also send Telegram when browser notification fires
    sendTelegramMessage(
      `⏰ *Recordatorio*\n\n*${task.title}*\n` +
      (task.notes ? `📝 ${task.notes}\n` : "") +
      `📅 ${formatDateTime(task.datetime)}\n` +
      `🏷️ ${categoryLabel(task.category)} · Prioridad ${priorityLabel(task.priority)}`
    );
  }, ms);

  // Store timer id in sessionStorage to cancel if task is deleted/edited
  const timers = getStoredTimers();
  if (timers[task.id]) clearTimeout(timers[task.id]);
  timers[task.id] = timerId;
  sessionStorage.setItem("notif_timers", JSON.stringify(Object.fromEntries(
    Object.entries(timers).map(([k, v]) => [k, String(v)])
  )));
}

export function cancelNotification(taskId) {
  const timers = getStoredTimers();
  if (timers[taskId]) clearTimeout(Number(timers[taskId]));
  delete timers[taskId];
  sessionStorage.setItem("notif_timers", JSON.stringify(timers));
}

function getStoredTimers() {
  try { return JSON.parse(sessionStorage.getItem("notif_timers") || "{}"); }
  catch { return {}; }
}

// ── Telegram ──────────────────────────────────────────────────────────────

export async function sendTelegramMessage(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

export async function sendTelegramTaskCreated(task) {
  await sendTelegramMessage(
    `✅ *Nueva tarea creada*\n\n` +
    `*${task.title}*\n` +
    (task.notes ? `📝 ${task.notes}\n` : "") +
    (task.datetime ? `📅 Vence: ${formatDateTime(task.datetime)}\n` : "") +
    `🏷️ ${categoryLabel(task.category)} · Prioridad ${priorityLabel(task.priority)}`
  );
}

export async function sendTelegramTaskDone(task) {
  await sendTelegramMessage(
    `☑️ *Tarea completada*\n\n*${task.title}*`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function formatDateTime(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  return d.toLocaleString("es-AR", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

export function formatDateOnly(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatTimeOnly(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function categoryLabel(id) {
  return { work: "🔵 Trabajo", home: "🟢 Hogar", payment: "🔴 Pagos" }[id] || id;
}

function priorityLabel(id) {
  return { high: "Alta 🔴", medium: "Media 🟡", low: "Baja ⚪" }[id] || id;
}
