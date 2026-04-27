// Service Worker - Mis Tareas
// Handles background push notifications and periodic checks

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Handle push notifications from server
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Mis Tareas', {
      body: data.body || 'Tenés una tarea pendiente',
      icon: '/icon.png',
      badge: '/icon.png',
      tag: data.tag || 'tarea',
      data: data,
      actions: [
        { action: 'open', title: 'Ver tarea' },
        { action: 'dismiss', title: 'Descartar' }
      ]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'open' || !e.action) {
    e.waitUntil(clients.openWindow('/'));
  }
});

// Periodic background sync for checking due tasks
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-tasks') {
    e.waitUntil(checkDueTasks());
  }
});

async function checkDueTasks() {
  const cache = await caches.open('tasks-cache');
  const response = await cache.match('tasks-data');
  if (!response) return;
  const tasks = await response.json();
  const now = new Date();
  tasks.forEach(task => {
    if (task.done || !task.datetime) return;
    const due = new Date(task.datetime);
    const diff = due - now;
    if (diff >= 0 && diff <= 60000) {
      self.registration.showNotification('⏰ ' + task.title, {
        body: task.notes || 'Es hora de esta tarea',
        tag: 'task-' + task.id,
      });
    }
  });
}
