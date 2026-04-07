const menuForm = document.getElementById('menu-form');
const resetMenuFormBtn = document.getElementById('reset-menu-form');
const menuMessageEl = document.getElementById('menu-message');
const adminMenuListEl = document.getElementById('admin-menu-list');
const ordersListEl = document.getElementById('orders-list');
const refreshOrdersBtn = document.getElementById('refresh-orders');
const orderFilterForm = document.getElementById('order-filter-form');
const resetOrderFilterBtn = document.getElementById('reset-order-filter');
const reportCardsEl = document.getElementById('report-cards');
const topItemsEl = document.getElementById('top-items');
const adminUserBadgeEl = document.getElementById('admin-user-badge');
const logoutBtn = document.getElementById('logout-btn');
const realtimeBadgeEl = document.getElementById('realtime-badge');
const toastContainerEl = document.getElementById('toast-container');

const statuses = ['pending', 'confirmed', 'preparing', 'delivering', 'completed', 'cancelled'];
const statusMap = {
  pending: 'Chờ xác nhận',
  confirmed: 'Đã xác nhận',
  preparing: 'Đang chuẩn bị',
  delivering: 'Đang giao',
  completed: 'Hoàn thành',
  cancelled: 'Đã hủy'
};
const orderFilter = {
  q: '',
  status: 'all',
  from: '',
  to: ''
};
let autoRefreshTimer;
let audioContext;

function getAudioContext() {
  if (!audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      audioContext = new AudioCtx();
    }
  }
  return audioContext;
}

function playNewOrderSound() {
  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(840, ctx.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(560, ctx.currentTime + 0.2);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.24);
}

function showToast(message, variant = 'info') {
  if (!toastContainerEl) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.textContent = message;
  toastContainerEl.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 260);
  }, 3200);
}

function connectRealtime() {
  if (typeof io !== 'function') {
    if (realtimeBadgeEl) realtimeBadgeEl.textContent = 'Realtime: không khả dụng';
    return;
  }

  const socket = io();
  socket.on('connect', () => {
    if (realtimeBadgeEl) realtimeBadgeEl.textContent = 'Realtime: đã kết nối';
  });

  socket.on('disconnect', () => {
    if (realtimeBadgeEl) realtimeBadgeEl.textContent = 'Realtime: mất kết nối';
  });

  socket.on('order:new', (payload) => {
    const customerName = payload?.customerName || 'khách hàng';
    const orderId = payload?.orderId || '';
    showToast(`Đơn mới #${orderId} từ ${customerName}`, 'success');
    playNewOrderSound();
    fetchOrders();
    fetchReport();
  });

  socket.on('order:status-updated', (payload) => {
    const orderId = payload?.orderId;
    const status = payload?.status;
    if (orderId && statusMap[status]) {
      showToast(`Đơn #${orderId} đã đổi sang: ${statusMap[status]}`);
      fetchOrders();
      fetchReport();
    }
  });
}

function toQueryString(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  return query.toString();
}

function formatMoney(value) {
  return Number(value).toLocaleString('vi-VN');
}

async function ensureAdminSession() {
  const response = await fetch('/api/admin/session');
  if (!response.ok) {
    window.location.href = '/admin/login';
    return false;
  }

  const result = await response.json();
  adminUserBadgeEl.textContent = result.user.fullName;
  return true;
}

function resetMenuForm() {
  menuForm.reset();
  menuForm.id.value = '';
  menuForm.isAvailable.checked = true;
}

async function fetchMenu() {
  const response = await fetch('/api/menu');
  const data = await response.json();

  adminMenuListEl.innerHTML = '';
  data.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div>
        <h4>${item.Name}</h4>
        <p>${item.Category === 'food' ? 'Đồ ăn' : 'Đồ uống'} - ${formatMoney(item.Price)} VND - ${item.IsAvailable ? 'Đang bán' : 'Tạm ẩn'}</p>
      </div>
      <div class="row-actions">
        <button data-edit="${item.Id}">Sửa</button>
        <button data-delete="${item.Id}" class="secondary">Xóa</button>
      </div>
    `;

    card.querySelector('[data-edit]').addEventListener('click', () => {
      menuForm.id.value = item.Id;
      menuForm.name.value = item.Name;
      menuForm.category.value = item.Category;
      menuForm.price.value = Number(item.Price);
      menuForm.isAvailable.checked = Boolean(item.IsAvailable);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    card.querySelector('[data-delete]').addEventListener('click', async () => {
      const ok = confirm(`Xóa món ${item.Name}?`);
      if (!ok) return;

      const deleteRes = await fetch(`/api/admin/menu/${item.Id}`, { method: 'DELETE' });
      const deleteResult = await deleteRes.json();
      menuMessageEl.textContent = deleteResult.message;
      if (deleteRes.ok) fetchMenu();
    });

    adminMenuListEl.appendChild(card);
  });
}

async function fetchReport() {
  const qs = toQueryString(orderFilter);
  const response = await fetch(`/api/admin/reports/summary?${qs}`);
  const result = await response.json();

  if (!response.ok) {
    reportCardsEl.innerHTML = `<p>${result.message || 'Không tải được báo cáo.'}</p>`;
    topItemsEl.innerHTML = '';
    return;
  }

  const summary = result.summary || {};
  reportCardsEl.innerHTML = `
    <div class="report-card">
      <p>Tổng đơn</p>
      <h3>${summary.TotalOrders || 0}</h3>
    </div>
    <div class="report-card">
      <p>Doanh thu gộp</p>
      <h3>${formatMoney(summary.GrossRevenue || 0)} VND</h3>
    </div>
    <div class="report-card">
      <p>Đã hoàn thành</p>
      <h3>${formatMoney(summary.CompletedRevenue || 0)} VND</h3>
    </div>
    <div class="report-card">
      <p>Đơn hủy</p>
      <h3>${summary.CancelledOrders || 0}</h3>
    </div>
  `;

  if (!result.topItems.length) {
    topItemsEl.innerHTML = '<p>Không có dữ liệu.</p>';
    return;
  }

  topItemsEl.innerHTML = result.topItems
    .map((item) => `<p>${item.ItemName}: ${item.SoldQty} món - ${formatMoney(item.Revenue)} VND</p>`)
    .join('');
}

menuForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  menuMessageEl.textContent = '';

  const payload = {
    name: menuForm.name.value,
    category: menuForm.category.value,
    price: Number(menuForm.price.value),
    isAvailable: menuForm.isAvailable.checked
  };

  const id = menuForm.id.value;
  const url = id ? `/api/admin/menu/${id}` : '/api/admin/menu';
  const method = id ? 'PUT' : 'POST';

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  menuMessageEl.textContent = result.message;

  if (response.ok) {
    resetMenuForm();
    fetchMenu();
  }
});

async function fetchOrders() {
  const qs = toQueryString(orderFilter);
  const response = await fetch(`/api/admin/orders?${qs}`);
  const orders = await response.json();

  if (!response.ok) {
    ordersListEl.innerHTML = `<p>${orders.message || 'Không tải được đơn hàng.'}</p>`;
    return;
  }

  ordersListEl.innerHTML = '';
  if (!orders.length) {
    ordersListEl.innerHTML = '<p>Chưa có đơn hàng.</p>';
    return;
  }

  orders.forEach((order) => {
    const card = document.createElement('div');
    card.className = 'order-card';

    const itemsText = order.items
      .map((item) => `${item.ItemName} x ${item.Quantity}`)
      .join(', ');

    card.innerHTML = `
      <h4>Đơn #${order.Id} - ${order.CustomerName}</h4>
      <p><strong>SĐT:</strong> ${order.CustomerPhone || '-'}</p>
      <p><strong>Địa chỉ:</strong> ${order.DeliveryAddress || '-'}</p>
      <p><strong>Món:</strong> ${itemsText || '-'}</p>
      <p><strong>Tổng:</strong> ${formatMoney(order.TotalAmount)} VND</p>
      <p><strong>Ghi chú:</strong> ${order.Note || '-'}</p>
      <label>Trạng thái:
        <select data-status="${order.Id}">
          ${statuses.map((status) => `<option value="${status}" ${order.Status === status ? 'selected' : ''}>${statusMap[status]}</option>`).join('')}
        </select>
      </label>
      <div class="row-actions">
        <a class="admin-link" target="_blank" href="/admin/invoice/${order.Id}">In hóa đơn</a>
        <a class="admin-link" target="_blank" href="/api/admin/orders/${order.Id}/pdf">Tải PDF</a>
      </div>
    `;

    card.querySelector('select').addEventListener('change', async (event) => {
      const nextStatus = event.target.value;
      const updateRes = await fetch(`/api/admin/orders/${order.Id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus })
      });

      const updateResult = await updateRes.json();
      if (!updateRes.ok) {
        alert(updateResult.message || 'Cập nhật thất bại');
        fetchOrders();
      }
    });

    ordersListEl.appendChild(card);
  });
}

orderFilterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  orderFilter.q = orderFilterForm.q.value.trim();
  orderFilter.status = orderFilterForm.status.value;
  orderFilter.from = orderFilterForm.from.value;
  orderFilter.to = orderFilterForm.to.value;
  fetchOrders();
  fetchReport();
});

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    fetchOrders();
    fetchReport();
  }, 8000);
}

resetOrderFilterBtn.addEventListener('click', () => {
  orderFilterForm.reset();
  orderFilter.q = '';
  orderFilter.status = 'all';
  orderFilter.from = '';
  orderFilter.to = '';
  fetchOrders();
  fetchReport();
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login';
});

resetMenuFormBtn.addEventListener('click', resetMenuForm);
refreshOrdersBtn.addEventListener('click', () => {
  fetchOrders();
  fetchReport();
});

ensureAdminSession().then((ok) => {
  if (!ok) return;
  fetchMenu();
  fetchOrders();
  fetchReport();
  startAutoRefresh();
  connectRealtime();
});
