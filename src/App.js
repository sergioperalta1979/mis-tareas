import { useState, useEffect, useMemo, useRef } from "react";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, query, orderBy, serverTimestamp
} from "firebase/firestore";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { db, auth, googleProvider } from "./firebase";
import {
  requestNotificationPermission,
  scheduleNotification,
  cancelNotification,
  sendTelegramTaskCreated,
  sendTelegramTaskDone,
  formatDateTime,
  formatDateOnly,
  formatTimeOnly,
} from "./notifications";

const CATEGORIES = [
  { id: "work",    label: "Trabajo", color: "#2563EB", dot: "🔵" },
  { id: "home",    label: "Hogar",   color: "#16A34A", dot: "🟢" },
  { id: "payment", label: "Pagos",   color: "#DC2626", dot: "🔴" },
];
const PRIORITIES = [
  { id: "high",   label: "Alta",  color: "#DC2626", bg: "#FEF2F2" },
  { id: "medium", label: "Media", color: "#D97706", bg: "#FFFBEB" },
  { id: "low",    label: "Baja",  color: "#6B7280", bg: "#F9FAFB" },
];
const FILTERS = ["Todas", "Hoy", "Próximas", "Completadas"];

function getDaysUntil(datetime) {
  if (!datetime) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(datetime); target.setHours(0,0,0,0);
  return Math.round((target - today) / 86400000);
}

function DueBadge({ datetime }) {
  if (!datetime) return null;
  const d = getDaysUntil(datetime);
  const time = formatTimeOnly(datetime);
  const [label, color, bg] =
    d < 0  ? [`Venció hace ${Math.abs(d)}d`, "#DC2626", "#FEF2F2"] :
    d === 0 ? [`Hoy ${time}`, "#D97706", "#FFFBEB"] :
    d === 1 ? [`Mañana ${time}`, "#2563EB", "#EFF6FF"] :
    d <= 7  ? [`En ${d}d · ${time}`, "#2563EB", "#EFF6FF"] :
              [formatDateOnly(datetime) + (time ? ` · ${time}` : ""), "#6B7280", "#F9FAFB"];
  return <span style={{ fontSize:11, fontWeight:600, color, background:bg, borderRadius:6, padding:"2px 8px" }}>{label}</span>;
}

// Convert datetime-local value to ISO string
function localToISO(val) {
  if (!val) return "";
  return new Date(val).toISOString();
}
// Convert ISO to datetime-local input value
function isoToLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY = { title:"", category:"work", priority:"medium", datetime:"", notes:"", telegramAlert:true };

export default function App() {
  const [user,     setUser]     = useState(undefined);
  const [tasks,    setTasks]    = useState([]);
  const [filter,   setFilter]   = useState("Todas");
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [editId,   setEditId]   = useState(null);
  const [search,   setSearch]   = useState("");
  const [toast,    setToast]    = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [notifOk,  setNotifOk]  = useState(false);
  const unsubRef = useRef(null);

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 2800); }

  // Auth
  useEffect(() => onAuthStateChanged(auth, u => setUser(u || null)), []);

  // Request notification permission once logged in
  useEffect(() => {
    if (user) requestNotificationPermission().then(ok => setNotifOk(ok));
  }, [user]);

  // Firestore listener
  useEffect(() => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    if (!user) { setTasks([]); return; }
    const q = query(collection(db, "tasks", user.uid, "items"), orderBy("createdAt", "desc"));
    unsubRef.current = onSnapshot(q, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setTasks(items);
      // Re-schedule notifications for all pending tasks
      items.forEach(t => { if (!t.done && t.datetime) scheduleNotification(t); });
    });
    return () => { if (unsubRef.current) unsubRef.current(); };
  }, [user]);

  async function login() {
    try { await signInWithPopup(auth, googleProvider); }
    catch { showToast("Error al iniciar sesión"); }
  }
  async function logout() { await signOut(auth); showToast("Sesión cerrada"); }

  async function saveTask() {
    if (!form.title.trim() || !user) return;
    setSaving(true);
    try {
      const col = collection(db, "tasks", user.uid, "items");
      const datetimeISO = form.datetime ? localToISO(form.datetime) : "";
      const payload = { ...form, datetime: datetimeISO, done: editId ? undefined : false };
      if (editId) {
        delete payload.done;
        await updateDoc(doc(col, editId), payload);
        cancelNotification(editId);
        if (datetimeISO) scheduleNotification({ ...payload, id: editId, done: false });
        showToast("Tarea actualizada ✓");
      } else {
        const ref = await addDoc(col, { ...payload, done: false, createdAt: serverTimestamp() });
        if (datetimeISO) scheduleNotification({ ...payload, id: ref.id, done: false });
        if (form.telegramAlert) await sendTelegramTaskCreated({ ...payload, datetime: datetimeISO });
        showToast("Tarea creada ✓");
      }
      setForm(EMPTY); setShowForm(false); setEditId(null);
    } catch (e) { showToast("Error al guardar"); console.error(e); }
    setSaving(false);
  }

  async function toggleDone(task) {
    const ref = doc(db, "tasks", user.uid, "items", task.id);
    const nowDone = !task.done;
    await updateDoc(ref, { done: nowDone });
    if (nowDone) {
      cancelNotification(task.id);
      await sendTelegramTaskDone(task);
    } else {
      if (task.datetime) scheduleNotification(task);
    }
  }

  async function deleteTask(id) {
    cancelNotification(id);
    await deleteDoc(doc(db, "tasks", user.uid, "items", id));
    showToast("Tarea eliminada");
  }

  function startEdit(task) {
    setForm({
      title: task.title,
      category: task.category,
      priority: task.priority,
      datetime: isoToLocal(task.datetime || ""),
      notes: task.notes || "",
      telegramAlert: task.telegramAlert !== false,
    });
    setEditId(task.id); setShowForm(true);
  }

  const filtered = useMemo(() => {
    let list = tasks.filter(t => t.title?.toLowerCase().includes(search.toLowerCase()));
    if (filter === "Hoy")          list = list.filter(t => !t.done && t.datetime && getDaysUntil(t.datetime) === 0);
    else if (filter === "Próximas") list = list.filter(t => !t.done && (!t.datetime || getDaysUntil(t.datetime) > 0));
    else if (filter === "Completadas") list = list.filter(t => t.done);
    else list = list.filter(t => !t.done);
    return list.sort((a, b) => {
      const pa = PRIORITIES.findIndex(p => p.id === a.priority);
      const pb = PRIORITIES.findIndex(p => p.id === b.priority);
      if (pa !== pb) return pa - pb;
      if (a.datetime && b.datetime) return new Date(a.datetime) - new Date(b.datetime);
      return a.datetime ? -1 : 1;
    });
  }, [tasks, filter, search]);

  const counts = {
    Todas:       tasks.filter(t => !t.done).length,
    Hoy:         tasks.filter(t => !t.done && t.datetime && getDaysUntil(t.datetime) === 0).length,
    Próximas:    tasks.filter(t => !t.done && (!t.datetime || getDaysUntil(t.datetime) > 0)).length,
    Completadas: tasks.filter(t => t.done).length,
  };
  const urgentCount = tasks.filter(t => !t.done && t.datetime && getDaysUntil(t.datetime) >= 0 && getDaysUntil(t.datetime) <= 1).length;

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Serif+Display&display=swap');
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { background:#FAFAFA; }
    button { cursor:pointer; border:none; background:none; font-family:inherit; }
    input,textarea,select { font-family:inherit; }
    .task-row { transition:background .15s; }
    .task-row:hover { background:#F3F4F6 !important; }
    .filter-btn,.add-btn,.check-circle { transition:all .15s; }
    .add-btn:hover { background:#1D4ED8 !important; }
    .del-btn:hover { color:#DC2626 !important; }
    input:focus,textarea:focus,select:focus { outline:2px solid #2563EB; outline-offset:1px; }
    .modal-overlay { animation:fadeIn .15s; }
    .modal-box { animation:slideUp .18s cubic-bezier(.22,1,.36,1); }
    .toast-el { animation:toastIn .2s cubic-bezier(.22,1,.36,1); }
    @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
    @keyframes slideUp { from{transform:translateY(18px);opacity:0} to{transform:translateY(0);opacity:1} }
    @keyframes toastIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
    ::-webkit-scrollbar{width:5px}
    ::-webkit-scrollbar-thumb{background:#E5E7EB;border-radius:10px}
    .toggle-switch { position:relative; display:inline-block; width:36px; height:20px; }
    .toggle-switch input { opacity:0; width:0; height:0; }
    .toggle-slider { position:absolute; cursor:pointer; inset:0; background:#D1D5DB; border-radius:20px; transition:.2s; }
    .toggle-slider:before { content:""; position:absolute; height:14px; width:14px; left:3px; bottom:3px; background:white; border-radius:50%; transition:.2s; }
    input:checked + .toggle-slider { background:#2563EB; }
    input:checked + .toggle-slider:before { transform:translateX(16px); }
  `;

  // ── Loading ───────────────────────────────────────────────────────────────
  if (user === undefined) return (
    <><style>{CSS}</style>
      <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#FAFAFA", fontFamily:"'DM Sans',sans-serif" }}>
        <div style={{ textAlign:"center", color:"#9CA3AF" }}><div style={{ fontSize:32, marginBottom:12 }}>⏳</div><div>Cargando...</div></div>
      </div>
    </>
  );

  // ── Login ─────────────────────────────────────────────────────────────────
  if (!user) return (
    <><style>{CSS}</style>
      <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#FAFAFA", fontFamily:"'DM Sans',sans-serif" }}>
        <div style={{ textAlign:"center", maxWidth:360, padding:"0 24px" }}>
          <div style={{ fontFamily:"'DM Serif Display',serif", fontSize:36, marginBottom:8, letterSpacing:-1 }}>Mis Tareas</div>
          <div style={{ color:"#9CA3AF", fontSize:14, marginBottom:36 }}>Tu gestor personal de tareas</div>
          <button onClick={login}
            style={{ display:"flex", alignItems:"center", gap:12, margin:"0 auto", background:"#fff", border:"1.5px solid #E5E7EB", borderRadius:12, padding:"13px 24px", fontSize:15, fontWeight:500, boxShadow:"0 2px 8px rgba(0,0,0,0.06)", color:"#111" }}>
            <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
            Ingresar con Google
          </button>
          <div style={{ marginTop:20, fontSize:12, color:"#D1D5DB" }}>Tus tareas son privadas y solo vos podés verlas</div>
        </div>
      </div>
    </>
  );

  // ── Main ──────────────────────────────────────────────────────────────────
  return (
    <><style>{CSS}</style>
    <div style={{ minHeight:"100vh", background:"#FAFAFA", fontFamily:"'DM Sans',sans-serif", color:"#111" }}>

      <div style={{ maxWidth:680, margin:"0 auto", padding:"36px 20px 0" }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:4 }}>
          <div>
            <div style={{ fontFamily:"'DM Serif Display',serif", fontSize:28, letterSpacing:-0.5 }}>Mis Tareas</div>
            <div style={{ fontSize:13, color:"#9CA3AF", marginTop:2 }}>
              {new Date().toLocaleDateString("es-AR", { weekday:"long", day:"numeric", month:"long" })}
            </div>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            {/* Notification status pill */}
            <div title={notifOk ? "Notificaciones activas" : "Notificaciones desactivadas"}
              style={{ fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:20,
                background: notifOk ? "#F0FDF4" : "#FFF7ED",
                color: notifOk ? "#16A34A" : "#D97706",
                border: `1px solid ${notifOk ? "#BBF7D0" : "#FDE68A"}` }}>
              {notifOk ? "🔔 Activas" : "🔕 Sin permiso"}
            </div>
            <button onClick={logout} title="Cerrar sesión"
              style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 10px", borderRadius:8, border:"1.5px solid #E5E7EB", fontSize:12, color:"#6B7280" }}>
              <img src={user.photoURL} alt="" style={{ width:20, height:20, borderRadius:"50%" }} />
              Salir
            </button>
            <button className="add-btn" onClick={() => { setForm(EMPTY); setEditId(null); setShowForm(true); }}
              style={{ background:"#2563EB", color:"#fff", borderRadius:10, padding:"10px 16px", fontSize:14, fontWeight:600, display:"flex", alignItems:"center", gap:6, boxShadow:"0 1px 3px rgba(37,99,235,0.3)" }}>
              <span style={{ fontSize:18, lineHeight:1 }}>+</span> Nueva
            </button>
          </div>
        </div>

        {/* Urgency bar */}
        {urgentCount > 0 && (
          <div style={{ background:"#FFFBEB", border:"1px solid #FDE68A", borderRadius:10, padding:"10px 14px", marginTop:16, display:"flex", alignItems:"center", gap:8, fontSize:13, color:"#92400E" }}>
            ⚠️ <span><strong>{urgentCount} tarea{urgentCount > 1 ? "s" : ""}</strong> vence{urgentCount === 1 ? "" : "n"} hoy</span>
          </div>
        )}

        {/* Search */}
        <div style={{ marginTop:16, position:"relative" }}>
          <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"#9CA3AF" }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar tareas..."
            style={{ width:"100%", padding:"10px 12px 10px 36px", border:"1px solid #E5E7EB", borderRadius:10, fontSize:14, background:"#fff" }} />
        </div>

        {/* Filters */}
        <div style={{ display:"flex", gap:6, marginTop:14, overflowX:"auto", paddingBottom:2 }}>
          {FILTERS.map(f => (
            <button key={f} className="filter-btn" onClick={() => setFilter(f)}
              style={{ padding:"7px 14px", borderRadius:8, fontSize:13, fontWeight:500, whiteSpace:"nowrap",
                background: filter === f ? "#111" : "#fff", color: filter === f ? "#fff" : "#6B7280",
                border: filter === f ? "1.5px solid #111" : "1.5px solid #E5E7EB" }}>
              {f}{counts[f] > 0 && <span style={{ marginLeft:4, fontSize:11, opacity:.7 }}>({counts[f]})</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div style={{ maxWidth:680, margin:"0 auto", padding:"16px 20px 80px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign:"center", padding:"60px 0", color:"#D1D5DB" }}>
            <div style={{ fontSize:36, marginBottom:12 }}>✓</div>
            <div style={{ fontSize:14 }}>No hay tareas aquí</div>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
            {filtered.map(task => {
              const cat = CATEGORIES.find(c => c.id === task.category) || CATEGORIES[0];
              const pri = PRIORITIES.find(p => p.id === task.priority) || PRIORITIES[1];
              return (
                <div key={task.id} className="task-row" style={{ display:"flex", alignItems:"flex-start", gap:12, padding:"13px 12px", borderRadius:10 }}>
                  <button className="check-circle" onClick={() => toggleDone(task)}
                    style={{ marginTop:2, width:20, height:20, borderRadius:"50%", flexShrink:0,
                      border:`2px solid ${task.done ? "#2563EB" : "#D1D5DB"}`,
                      background: task.done ? "#2563EB" : "transparent",
                      display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {task.done && <span style={{ color:"#fff", fontSize:11 }}>✓</span>}
                  </button>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      <span style={{ fontSize:15, fontWeight:500, color: task.done ? "#9CA3AF" : "#111", textDecoration: task.done ? "line-through" : "none" }}>
                        {task.title}
                      </span>
                      {!task.done && <span style={{ fontSize:10, fontWeight:700, color:pri.color, background:pri.bg, borderRadius:5, padding:"2px 7px", letterSpacing:.5, textTransform:"uppercase" }}>{pri.label}</span>}
                      {task.telegramAlert && !task.done && <span title="Alerta Telegram" style={{ fontSize:12 }}>📲</span>}
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:5, flexWrap:"wrap" }}>
                      <span style={{ fontSize:12, color:cat.color, fontWeight:500 }}>{cat.dot} {cat.label}</span>
                      {task.datetime && <DueBadge datetime={task.datetime} />}
                    </div>
                    {task.notes && <div style={{ fontSize:12, color:"#9CA3AF", marginTop:4, fontStyle:"italic" }}>{task.notes}</div>}
                  </div>
                  <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                    <button onClick={() => startEdit(task)} style={{ fontSize:14, color:"#9CA3AF", padding:"4px 6px", borderRadius:6 }}>✏️</button>
                    <button className="del-btn" onClick={() => deleteTask(task.id)} style={{ fontSize:14, color:"#9CA3AF", padding:"4px 6px", borderRadius:6 }}>🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setShowForm(false); setEditId(null); } }}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.25)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:100 }}>
          <div className="modal-box" style={{ background:"#fff", borderRadius:"18px 18px 0 0", width:"100%", maxWidth:680, padding:"28px 24px 40px", boxShadow:"0 -4px 40px rgba(0,0,0,0.12)", maxHeight:"90vh", overflowY:"auto" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
              <span style={{ fontFamily:"'DM Serif Display',serif", fontSize:20 }}>{editId ? "Editar tarea" : "Nueva tarea"}</span>
              <button onClick={() => { setShowForm(false); setEditId(null); }} style={{ fontSize:22, color:"#9CA3AF" }}>×</button>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

              {/* Title */}
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:"#6B7280", display:"block", marginBottom:5, letterSpacing:.3 }}>TÍTULO *</label>
                <input value={form.title} onChange={e => setForm(f => ({ ...f, title:e.target.value }))} placeholder="¿Qué necesitás hacer?"
                  style={{ width:"100%", padding:"11px 13px", border:"1.5px solid #E5E7EB", borderRadius:10, fontSize:15 }} />
              </div>

              {/* Category + Priority */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <div>
                  <label style={{ fontSize:12, fontWeight:600, color:"#6B7280", display:"block", marginBottom:5, letterSpacing:.3 }}>CATEGORÍA</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category:e.target.value }))}
                    style={{ width:"100%", padding:"10px 12px", border:"1.5px solid #E5E7EB", borderRadius:10, fontSize:14, background:"#fff" }}>
                    {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.dot} {c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:600, color:"#6B7280", display:"block", marginBottom:5, letterSpacing:.3 }}>PRIORIDAD</label>
                  <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority:e.target.value }))}
                    style={{ width:"100%", padding:"10px 12px", border:"1.5px solid #E5E7EB", borderRadius:10, fontSize:14, background:"#fff" }}>
                    {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              </div>

              {/* Date + Time (single datetime-local input) */}
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:"#6B7280", display:"block", marginBottom:5, letterSpacing:.3 }}>FECHA Y HORA DE VENCIMIENTO</label>
                <input type="datetime-local" value={form.datetime} onChange={e => setForm(f => ({ ...f, datetime:e.target.value }))}
                  style={{ width:"100%", padding:"10px 13px", border:"1.5px solid #E5E7EB", borderRadius:10, fontSize:14 }} />
                {form.datetime && (
                  <div style={{ marginTop:5, fontSize:12, color:"#6B7280" }}>
                    📅 {formatDateTime(localToISO(form.datetime))}
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:"#6B7280", display:"block", marginBottom:5, letterSpacing:.3 }}>NOTAS (opcional)</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes:e.target.value }))} placeholder="Detalles adicionales..." rows={2}
                  style={{ width:"100%", padding:"10px 13px", border:"1.5px solid #E5E7EB", borderRadius:10, fontSize:14, resize:"none" }} />
              </div>

              {/* Telegram toggle */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background:"#F8FAFF", border:"1.5px solid #DBEAFE", borderRadius:10, padding:"12px 14px" }}>
                <div>
                  <div style={{ fontSize:13, fontWeight:600, color:"#1E40AF" }}>📲 Alerta por Telegram</div>
                  <div style={{ fontSize:11, color:"#93C5FD", marginTop:2 }}>Recibir notificación en @AlertaSergio_bot</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={form.telegramAlert} onChange={e => setForm(f => ({ ...f, telegramAlert:e.target.checked }))} />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {/* Save button */}
              <button onClick={saveTask} disabled={!form.title.trim() || saving}
                style={{ background: form.title.trim() ? "#2563EB" : "#E5E7EB", color: form.title.trim() ? "#fff" : "#9CA3AF",
                  borderRadius:11, padding:"13px", fontSize:15, fontWeight:600, marginTop:4, transition:"all .15s",
                  boxShadow: form.title.trim() ? "0 2px 8px rgba(37,99,235,0.25)" : "none" }}>
                {saving ? "Guardando..." : editId ? "Guardar cambios" : "Crear tarea"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-el" style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)",
          background:"#111", color:"#fff", borderRadius:10, padding:"10px 20px", fontSize:13, fontWeight:500, zIndex:200, whiteSpace:"nowrap", boxShadow:"0 4px 20px rgba(0,0,0,0.2)" }}>
          {toast}
        </div>
      )}
    </div>
    </>
  );
}
