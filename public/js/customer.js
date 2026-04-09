const menuListEl = document.getElementById('menu-list');
const cartEmptyEl = document.getElementById('cart-empty');
const cartListEl = document.getElementById('cart-list');
const cartTotalEl = document.getElementById('cart-total');
const orderForm = document.getElementById('order-form');
const orderMessageEl = document.getElementById('order-message');
const tableContextEl = document.getElementById('table-context');
const orderStatusPanelEl = document.getElementById('order-status-panel');
const orderStatusValueEl = document.getElementById('order-status-value');
const customerOrderHistoryEl = document.getElementById('customer-order-history');
const outstandingTotalEl = document.getElementById('outstanding-total');
const realtimeBadgeEl = document.getElementById('realtime-badge');

const cart = new Map();
let menuItems = [];
let tableToken = '';
let activeOrderId = null;
let statusSyncTimer = null;

const statusMap = {
  pending: 'Chờ xác nhận',
  preparing: 'Đang chuẩn bị',
  completed: 'Hoàn thành',
  cancelled: 'Đã hủy'
};

function formatMoney(value) {
  return Number(value).toLocaleString('vi-VN');
}

function getTableTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('table') || '').trim();
}

async function fetchTableContext() {
  const response = await fetch(`/api/table-context?token=${encodeURIComponent(tableToken)}`);
  const result = await response.json();

  if (!response.ok) {
    tableContextEl.textContent = result.message || 'Không xác định được bàn.';
    return false;
  }

  tableContextEl.textContent = `${result.StoreName} | Bàn ${result.TableNumber}`;
  return true;
}

async function fetchMenu() {
  const response = await fetch(`/api/menu/by-table?token=${encodeURIComponent(tableToken)}`);
  const data = await response.json();

  if (!response.ok) {
    menuListEl.innerHTML = `<p>${data.message || 'Không tải được menu.'}</p>`;
    return;
  }

  menuItems = data.filter((item) => item.IsAvailable);
  renderMenu();
}

function renderMenu() {
  menuListEl.innerHTML = '';

  if (!menuItems.length) {
    menuListEl.innerHTML = '<p>Chưa có món đang bán.</p>';
    return;
  }

  menuItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div>
        <h4>${item.Name}</h4>
        <p>${item.Category === 'food' ? 'Đồ ăn' : 'Đồ uống'}</p>
      </div>
      <div class="item-actions">
        <strong>${formatMoney(item.Price)} VND</strong>
        <button data-id="${item.Id}">Thêm</button>
      </div>
    `;

    card.querySelector('button').addEventListener('click', () => {
      const existing = cart.get(item.Id) || { ...item, quantity: 0 };
      existing.quantity += 1;
      cart.set(item.Id, existing);
      renderCart();
    });

    menuListEl.appendChild(card);
  });
}

function renderCart() {
  const items = Array.from(cart.values());
  cartListEl.innerHTML = '';

  if (!items.length) {
    cartEmptyEl.style.display = 'block';
    cartTotalEl.textContent = '0';
    return;
  }

  cartEmptyEl.style.display = 'none';

  let total = 0;
  items.forEach((item) => {
    total += Number(item.Price) * item.quantity;

    const line = document.createElement('div');
    line.className = 'cart-line';
    line.innerHTML = `
      <span>${item.Name} x ${item.quantity}</span>
      <div class="row-actions">
        <span>${formatMoney(Number(item.Price) * item.quantity)} VND</span>
        <button data-minus="${item.Id}" class="small secondary">-</button>
        <button data-plus="${item.Id}" class="small">+</button>
      </div>
    `;

    line.querySelector('[data-minus]').addEventListener('click', () => {
      const current = cart.get(item.Id);
      current.quantity -= 1;
      if (current.quantity <= 0) {
        cart.delete(item.Id);
      } else {
        cart.set(item.Id, current);
      }
      renderCart();
    });

    line.querySelector('[data-plus]').addEventListener('click', () => {
      const current = cart.get(item.Id);
      current.quantity += 1;
      cart.set(item.Id, current);
      renderCart();
    });

    cartListEl.appendChild(line);
  });

  cartTotalEl.textContent = formatMoney(total);
}

function updateOrderStatusUi(status) {
  if (!orderStatusPanelEl || !orderStatusValueEl) return;
  orderStatusPanelEl.style.display = 'block';
  orderStatusValueEl.textContent = statusMap[status] || status;
}

function setRealtimeBadge(text) {
  if (!realtimeBadgeEl) return;
  realtimeBadgeEl.textContent = text;
}

function updateOrderCardStatus(orderId, status) {
  if (!customerOrderHistoryEl || !Number.isInteger(Number(orderId))) return;
  const orderCardEl = customerOrderHistoryEl.querySelector(`[data-order-id="${Number(orderId)}"]`);
  if (!orderCardEl) return;

  const statusEl = orderCardEl.querySelector('[data-order-status]');
  if (!statusEl) return;
  statusEl.textContent = statusMap[status] || status;
}

function renderOrderHistory(orders) {
  if (!customerOrderHistoryEl) return;

  if (!orders.length) {
    customerOrderHistoryEl.innerHTML = '<p>Chưa có đơn nào chưa thanh toán tại bàn này.</p>';
    return;
  }

  customerOrderHistoryEl.innerHTML = orders.map((order) => {
    const itemsText = (order.items || []).map((item) => `${item.ItemName} x ${item.Quantity}`).join(', ');
    return `
      <article class="order-card" data-order-id="${order.Id}">
        <h4>Đơn #${order.Id}</h4>
        <p><strong>Trạng thái:</strong> <span data-order-status>${order.statusText || statusMap[order.Status] || order.Status}</span></p>
        <p><strong>Món:</strong> ${itemsText || '-'}</p>
        <p><strong>Tổng:</strong> ${formatMoney(order.TotalAmount)} VND</p>
        <p><strong>Ghi chú:</strong> ${order.Note || '-'}</p>
      </article>
    `;
  }).join('');
}

async function fetchOrderHistory() {
  if (!tableToken || !customerOrderHistoryEl) return;

  try {
    const response = await fetch(`/api/orders/history?tableToken=${encodeURIComponent(tableToken)}`);
    const result = await response.json();

    if (!response.ok) {
      customerOrderHistoryEl.innerHTML = `<p>${result.message || 'Không tải được lịch sử đơn.'}</p>`;
      return;
    }

    const orders = Array.isArray(result.orders) ? result.orders : [];
    renderOrderHistory(orders);
    if (outstandingTotalEl) {
      outstandingTotalEl.textContent = formatMoney(result.outstandingTotal || 0);
    }

    const latest = orders[0];
    if (!latest) {
      if (orderStatusPanelEl) {
        orderStatusPanelEl.style.display = 'none';
      }
      activeOrderId = null;
      return;
    }

    activeOrderId = Number(latest.Id);
    updateOrderStatusUi(latest.Status);
  } catch {
    customerOrderHistoryEl.innerHTML = '<p>Không tải được lịch sử đơn.</p>';
  }
}

async function pollOrderStatus() {
  if (!activeOrderId || !tableToken) return;

  try {
    const response = await fetch(`/api/orders/${activeOrderId}/status?tableToken=${encodeURIComponent(tableToken)}`);
    const result = await response.json();
    if (!response.ok) return;

    updateOrderStatusUi(result.status);
  } catch {
    // No-op.
  }
}

function startOrderStatusTracking(orderId) {
  activeOrderId = Number(orderId);
  if (!Number.isInteger(activeOrderId)) return;

  updateOrderStatusUi('pending');
  pollOrderStatus();
}

function connectRealtime() {
  if (typeof io !== 'function' || !tableToken) {
    setRealtimeBadge('Realtime: không khả dụng');
    return;
  }

  const socket = io({ query: { tableToken } });

  socket.on('connect', () => {
    setRealtimeBadge('Realtime: đã kết nối');
  });

  socket.on('disconnect', () => {
    setRealtimeBadge('Realtime: mất kết nối, đang thử lại...');
  });

  socket.on('connect_error', () => {
    setRealtimeBadge('Realtime: lỗi kết nối, đang thử lại...');
  });

  socket.on('table:order-changed', (payload) => {
    if (payload && payload.orderId && payload.status) {
      updateOrderCardStatus(payload.orderId, payload.status);
      if (Number(payload.orderId) === Number(activeOrderId)) {
        updateOrderStatusUi(payload.status);
      }
    }

    fetchOrderHistory();
    pollOrderStatus();
  });
}

function startStatusSyncFallback() {
  if (statusSyncTimer) {
    clearInterval(statusSyncTimer);
  }

  // Mobile networks may suspend websocket frequently, so keep a light sync fallback.
  statusSyncTimer = setInterval(() => {
    fetchOrderHistory();
    pollOrderStatus();
  }, 12000);
}

orderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  orderMessageEl.textContent = '';

  const formData = new FormData(orderForm);
  const payload = {
    tableToken,
    note: formData.get('note'),
    items: Array.from(cart.values()).map((item) => ({
      menuItemId: item.Id,
      quantity: item.quantity
    }))
  };

  if (!payload.items.length) {
    orderMessageEl.textContent = 'Vui lòng thêm ít nhất 1 món vào giỏ.';
    return;
  }

  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok) {
    orderMessageEl.textContent = result.message || 'Đặt món thất bại.';
    return;
  }

  orderMessageEl.textContent = `${result.message} Mã đơn: #${result.orderId}`;
  startOrderStatusTracking(result.orderId);
  fetchOrderHistory();
  orderForm.reset();
  cart.clear();
  renderCart();
});

async function init() {
  tableToken = getTableTokenFromUrl();
  if (!tableToken) {
    tableContextEl.textContent = 'Thiếu mã QR bàn. Vui lòng quét lại mã QR tại bàn.';
    menuListEl.innerHTML = '<p>Không thể tải menu nếu chưa có mã QR bàn.</p>';
    return;
  }

  const ok = await fetchTableContext();
  if (!ok) {
    menuListEl.innerHTML = '<p>Mã QR bàn không hợp lệ hoặc đã bị khóa.</p>';
    return;
  }

  fetchMenu();
  fetchOrderHistory();
  connectRealtime();
  startStatusSyncFallback();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      fetchOrderHistory();
      pollOrderStatus();
    }
  });
}

init();
