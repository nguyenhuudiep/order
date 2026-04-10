const menuForm = document.getElementById('menu-form');
const resetMenuFormBtn = document.getElementById('reset-menu-form');
const menuMessageEl = document.getElementById('menu-message');
const adminMenuListEl = document.getElementById('admin-menu-list');
const tableForm = document.getElementById('table-form');
const resetTableFormBtn = document.getElementById('reset-table-form');
const tableSubmitBtn = document.getElementById('table-submit-btn');
const tableMessageEl = document.getElementById('table-message');
const tablesListEl = document.getElementById('tables-list');
const tableModeHintEl = document.getElementById('table-mode-hint');
const tableQuantityFieldEl = document.getElementById('table-quantity-field');
const tableEditFieldsEl = document.getElementById('table-edit-fields');
const printQrBtn = document.getElementById('print-qr-btn');
const ordersListEl = document.getElementById('orders-list');
const ordersPaginationEl = document.getElementById('orders-pagination');
const refreshOrdersBtn = document.getElementById('refresh-orders');
const orderFilterForm = document.getElementById('order-filter-form');
const resetOrderFilterBtn = document.getElementById('reset-order-filter');
const reportCardsEl = document.getElementById('report-cards');
const topItemsEl = document.getElementById('top-items');
const adminUserBadgeEl = document.getElementById('admin-user-badge');
const logoutBtn = document.getElementById('logout-btn');
const editProfileBtn = document.getElementById('edit-profile-btn');
const realtimeBadgeEl = document.getElementById('realtime-badge');
const toastContainerEl = document.getElementById('toast-container');
const kpiTotalOrdersEl = document.getElementById('kpi-total-orders');
const kpiGrossRevenueEl = document.getElementById('kpi-gross-revenue');
const kpiCompletedRevenueEl = document.getElementById('kpi-completed-revenue');
const kpiCancelledOrdersEl = document.getElementById('kpi-cancelled-orders');
const tabButtons = Array.from(document.querySelectorAll('[data-tab-btn]'));
const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'));

const statuses = ['preparing', 'completed', 'cancelled'];
const statusMap = {
  pending: 'Chờ xác nhận',
  preparing: 'Đang chuẩn bị',
  completed: 'Hoàn thành',
  cancelled: 'Hủy'
};
const statusPriority = {
  preparing: 1,
  pending: 2,
  completed: 3,
  cancelled: 4
};
const orderFilter = {
  q: '',
  status: 'all',
  from: null,
  to: null
};
let audioContext;
let currentTables = [];
let menuLoaded = false;
let tablesLoaded = false;
let currentAdminUser = null;
const ORDERS_PAGE_SIZE = 10;
let currentOrdersPage = 1;
let storeSyncTimer = null;
let hasActiveOrders = false;
let storeSocketConnected = false;

function buildPageItems(totalPages, currentPage) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const items = [1];
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);

  if (start > 2) items.push('...');
  for (let page = start; page <= end; page += 1) {
    items.push(page);
  }
  if (end < totalPages - 1) items.push('...');
  items.push(totalPages);

  return items;
}

function renderOrdersPagination(totalItems) {
  if (!ordersPaginationEl) return;

  const totalPages = Math.max(1, Math.ceil(totalItems / ORDERS_PAGE_SIZE));
  if (currentOrdersPage > totalPages) {
    currentOrdersPage = totalPages;
  }

  const prevDisabled = currentOrdersPage <= 1;
  const nextDisabled = currentOrdersPage >= totalPages;
  const pageItems = buildPageItems(totalPages, currentOrdersPage);
  const pagesHtml = pageItems.map((item) => {
    if (item === '...') {
      return '<span class="orders-pagination-ellipsis">...</span>';
    }

    const isActive = Number(item) === currentOrdersPage;
    return `<button type="button" class="secondary small page-number ${isActive ? 'active' : ''}" data-order-page="${item}" ${isActive ? 'aria-current="page"' : ''}>${item}</button>`;
  }).join('');

  ordersPaginationEl.innerHTML = `
    <div class="orders-pagination-summary">Trang ${currentOrdersPage}/${totalPages} • ${totalItems} đơn</div>
    <div class="orders-pagination-actions">
      <button type="button" class="secondary small" data-order-page="prev" ${prevDisabled ? 'disabled' : ''}>Trước</button>
      ${pagesHtml}
      <button type="button" class="secondary small" data-order-page="next" ${nextDisabled ? 'disabled' : ''}>Sau</button>
    </div>
  `;
}

function toQueryString(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  return query.toString();
}

function withNoCache(url) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_ts=${Date.now()}`;
}

async function fetchJsonNoCache(url) {
  const response = await fetch(withNoCache(url), {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache'
    }
  });

  const result = await response.json().catch(() => ({}));
  return { response, result };
}

function formatMoney(value) {
  return Number(value).toLocaleString('vi-VN');
}

function renderMoney(value, tone = 'warm') {
  return `<span class="money money-${tone}">${formatMoney(value)} VND</span>`;
}

function parseMoneyInput(value) {
  return Number(String(value || '').replace(/[^0-9]/g, ''));
}

function formatMoneyInput(value) {
  const numericValue = parseMoneyInput(value);
  if (!numericValue) return '';
  return formatMoney(numericValue);
}

function initMoneyInputField() {
  if (!menuForm?.price) return;

  menuForm.price.addEventListener('input', () => {
    const formatted = formatMoneyInput(menuForm.price.value);
    menuForm.price.value = formatted;
  });
}

function getTodayIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
  return local.toISOString().slice(0, 10);
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function downloadQrImage(dataUrl, tableNumber) {
  if (!dataUrl) {
    showToast('Không có ảnh QR để tải.');
    return;
  }

  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = `qr-ban-${String(tableNumber).replace(/\s+/g, '-').toLowerCase()}.png`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function printAllQrs() {
  if (!currentTables.length) {
    showToast('Chưa có bàn để in QR.');
    return;
  }

  const cards = currentTables.map((table) => `
    <article class="qr-card">
      <img src="${table.qrImageDataUrl}" alt="QR bàn ${escapeHtml(table.TableNumber)}" />
      <h3>Bàn ${escapeHtml(table.TableNumber)}</h3>
      <p>${escapeHtml(table.orderLink || '')}</p>
    </article>
  `).join('');

  const printWindow = window.open('', '_blank', 'width=1000,height=800');
  if (!printWindow) {
    showToast('Trình duyệt đang chặn cửa sổ in QR.');
    return;
  }

  printWindow.document.write(`
    <!doctype html>
    <html lang="vi">
    <head>
      <meta charset="utf-8" />
      <title>In QR bàn</title>
      <style>
        body { margin: 16px; font-family: 'Segoe UI', Tahoma, sans-serif; color: #1f2937; }
        h1 { margin: 0 0 16px; font-size: 22px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
        .qr-card { border: 1px dashed #9ca3af; border-radius: 12px; padding: 12px; text-align: center; break-inside: avoid; }
        .qr-card img { width: 170px; height: 170px; object-fit: contain; }
        .qr-card h3 { margin: 8px 0 4px; font-size: 18px; }
        .qr-card p { margin: 0; font-size: 12px; word-break: break-word; }
      </style>
    </head>
    <body>
      <h1>Danh sách QR bàn - In dán tại quầy</h1>
      <section class="grid">${cards}</section>
      <script>
        window.onload = function() { window.print(); };
      <\/script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function getAudioContext() {
  if (!audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) audioContext = new AudioCtx();
  }
  return audioContext;
}

function playNewOrderSound() {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
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

async function ensureSession() {
  const response = await fetch('/api/admin/session');
  if (!response.ok) {
    window.location.href = '/admin/login';
    return false;
  }

  const result = await response.json();
  if (result.user.role !== 'store') {
    window.location.href = '/admin';
    return false;
  }

  currentAdminUser = result.user;
  adminUserBadgeEl.textContent = `${result.user.fullName} (Cửa hàng)`;
  return true;
}

async function updateOwnProfile() {
  if (!currentAdminUser) return;

  const fullNameInput = window.prompt('Họ tên hiển thị mới:', currentAdminUser.fullName || '');
  if (fullNameInput === null) return;

  const usernameInput = window.prompt('Tên đăng nhập mới:', currentAdminUser.username || '');
  if (usernameInput === null) return;

  const fullName = fullNameInput.trim();
  const username = usernameInput.trim();

  if (!fullName || !username) {
    showToast('Họ tên và tên đăng nhập không được để trống.');
    return;
  }

  const passwordInput = window.prompt('Mật khẩu mới (để trống nếu không đổi):', '');
  if (passwordInput === null) return;
  const password = passwordInput.trim();

  if (password && password.length < 6) {
    showToast('Mật khẩu mới phải có ít nhất 6 ký tự.');
    return;
  }

  try {
    const response = await fetch('/api/admin/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        fullName,
        password: password || undefined
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.message || 'Không cập nhật được tài khoản.');
    }

    currentAdminUser = result.user || { ...currentAdminUser, username, fullName };
    adminUserBadgeEl.textContent = `${currentAdminUser.fullName} (Cửa hàng)`;
    showToast(result.message || 'Cập nhật tài khoản thành công.', 'success');
  } catch (error) {
    showToast(error.message || 'Không cập nhật được tài khoản.');
  }
}

function resetMenuForm() {
  menuForm.reset();
  menuForm.id.value = '';
  menuForm.price.value = '';
  menuForm.isAvailable.checked = true;
}

function resetTableForm() {
  tableForm.reset();
  tableForm.id.value = '';
  if (tableForm.quantity) {
    tableForm.quantity.value = '1';
  }
  tableForm.isActive.checked = true;
  setTableFormMode(false);
}

function setTableFormMode(isEditMode) {
  if (tableQuantityFieldEl) {
    tableQuantityFieldEl.hidden = isEditMode;
  }
  if (tableEditFieldsEl) {
    tableEditFieldsEl.hidden = !isEditMode;
  }

  if (tableModeHintEl) {
    tableModeHintEl.textContent = isEditMode
      ? 'Chế độ sửa bàn: cập nhật số bàn hoặc mã QR cho từng bàn.'
      : 'Nhập số lượng bàn cần thêm, hệ thống sẽ tự đánh số nối tiếp.';
  }

  if (tableForm.tableNumber) {
    tableForm.tableNumber.required = isEditMode;
  }
  if (tableForm.quantity) {
    tableForm.quantity.required = !isEditMode;
  }

  if (tableSubmitBtn) {
    tableSubmitBtn.textContent = isEditMode ? 'Cập nhật bàn' : 'Tạo bàn';
  }
}

function renderTables(tables) {
  currentTables = tables;

  if (!tables.length) {
    tablesListEl.innerHTML = '<p>Chưa có bàn nào.</p>';
    return;
  }

  tablesListEl.innerHTML = tables.map((table) => `
    <div class="order-card">
      <h4>Bàn ${table.TableNumber}</h4>
      <p><strong>QR Token:</strong> ${table.QrToken}</p>
      <p><strong>Link order:</strong> ${table.orderLink}</p>
      <p><strong>Trạng thái:</strong> ${table.IsActive ? 'Hoạt động' : 'Ngưng'}</p>
      <div class="qr-preview-wrap">
        <img class="qr-preview" src="${table.qrImageDataUrl}" alt="QR bàn ${table.TableNumber}" />
      </div>
      <div class="row-actions">
        <a class="admin-link" href="${table.orderLink}" target="_blank">Mở link order</a>
        <button class="small" data-edit-table="${table.Id}">Sửa</button>
        <button class="small secondary" data-delete-table="${table.Id}">Xóa</button>
        <button class="small secondary" data-copy-link="${table.orderLink}">Sao chép link</button>
        <button class="small secondary" data-download-qr="${table.Id}">Tải QR PNG</button>
      </div>
    </div>
  `).join('');

  tablesListEl.querySelectorAll('[data-copy-link]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copyLink);
        showToast('Đã sao chép link order.');
      } catch {
        showToast('Không thể sao chép link, vui lòng sao chép thủ công.');
      }
    });
  });

  tablesListEl.querySelectorAll('[data-download-qr]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tableId = Number(btn.getAttribute('data-download-qr'));
      const targetTable = currentTables.find((table) => Number(table.Id) === tableId);
      if (!targetTable) {
        showToast('Không tìm thấy bàn để tải QR.');
        return;
      }
      downloadQrImage(targetTable.qrImageDataUrl, targetTable.TableNumber);
    });
  });

  tablesListEl.querySelectorAll('[data-edit-table]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tableId = Number(btn.getAttribute('data-edit-table'));
      const table = currentTables.find((item) => Number(item.Id) === tableId);
      if (!table) {
        showToast('Không tìm thấy bàn để sửa.');
        return;
      }

      tableForm.id.value = String(table.Id);
      setTableFormMode(true);
      tableForm.tableNumber.value = table.TableNumber;
      tableForm.qrToken.value = table.QrToken;
      tableForm.isActive.checked = Boolean(table.IsActive);
      showToast(`Đang sửa bàn ${table.TableNumber}.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  tablesListEl.querySelectorAll('[data-delete-table]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tableId = Number(btn.getAttribute('data-delete-table'));
      const table = currentTables.find((item) => Number(item.Id) === tableId);
      const ok = window.confirm(`Xóa bàn ${table?.TableNumber || ''}?`);
      if (!ok) return;

      const response = await fetch(`/api/store/tables/${tableId}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        showToast(result.message || 'Không xóa được bàn.');
        return;
      }

      if (String(tableForm.id.value) === String(tableId)) {
        resetTableForm();
      }
      showToast(result.message || 'Đã xóa bàn.', 'success');
      fetchTables();
    });
  });
}

function renderStatusButtons(order) {
  return statuses.map((status) => `
    <button
      type="button"
      class="status-btn status-${status} ${order.Status === status ? 'active' : ''}"
      data-order-status="${order.Id}"
      data-value="${status}"
      aria-pressed="${order.Status === status ? 'true' : 'false'}"
    >
      ${statusMap[status]}
    </button>
  `).join('');
}

function refreshOrdersAndReport() {
  fetchOrders();
  fetchReport();
}

function applyOrderStatusOnCard(card, nextStatus) {
  const statusPill = card.querySelector('.status-pill');
  if (statusPill) {
    statusPill.className = `status-pill status-${nextStatus}`;
    statusPill.textContent = statusMap[nextStatus] || nextStatus;
  }

  const statusButtons = card.querySelectorAll('[data-order-status]');
  statusButtons.forEach((btn) => {
    const btnStatus = btn.getAttribute('data-value');
    const isActive = btnStatus === nextStatus;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

async function fetchTables() {
  const response = await fetch('/api/store/tables');
  const tables = await response.json();

  if (!response.ok) {
    tablesListEl.innerHTML = `<p>${tables.message || 'Không tải được danh sách bàn.'}</p>`;
    return;
  }

  renderTables(tables);
}

async function fetchMenu() {
  const response = await fetch('/api/store/menu');
  const data = await response.json();

  adminMenuListEl.innerHTML = '';
  if (!response.ok) {
    adminMenuListEl.innerHTML = `<p>${data.message || 'Không tải được menu.'}</p>`;
    return;
  }

  data.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div>
        <h4>${item.Name}</h4>
        <p>${item.Category === 'food' ? 'Đồ ăn' : 'Đồ uống'} - ${renderMoney(item.Price, 'rose')} - ${item.IsAvailable ? 'Đang bán' : 'Tạm ẩn'}</p>
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
      menuForm.price.value = formatMoney(item.Price);
      menuForm.isAvailable.checked = Boolean(item.IsAvailable);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    card.querySelector('[data-delete]').addEventListener('click', async () => {
      const ok = confirm(`Xóa món ${item.Name}?`);
      if (!ok) return;
      const deleteRes = await fetch(`/api/store/menu/${item.Id}`, { method: 'DELETE' });
      const deleteResult = await deleteRes.json();
      menuMessageEl.textContent = deleteResult.message;
      if (deleteRes.ok) fetchMenu();
    });

    adminMenuListEl.appendChild(card);
  });
}

async function fetchReport() {
  const qs = toQueryString(orderFilter);
  const { response, result } = await fetchJsonNoCache(`/api/store/reports/summary?${qs}`);

  if (!response.ok) {
    reportCardsEl.innerHTML = `<p>${result.message || 'Không tải được báo cáo.'}</p>`;
    topItemsEl.innerHTML = '';
    return;
  }

  const summary = result.summary || {};
  if (kpiTotalOrdersEl) kpiTotalOrdersEl.textContent = summary.TotalOrders || 0;
  if (kpiGrossRevenueEl) kpiGrossRevenueEl.innerHTML = renderMoney(summary.GrossRevenue || 0, 'sun');
  if (kpiCompletedRevenueEl) kpiCompletedRevenueEl.innerHTML = renderMoney(summary.CompletedRevenue || 0, 'mint');
  if (kpiCancelledOrdersEl) kpiCancelledOrdersEl.textContent = summary.CancelledOrders || 0;

  reportCardsEl.innerHTML = `
    <div class="report-card"><p>Tổng đơn</p><h3>${summary.TotalOrders || 0}</h3></div>
    <div class="report-card"><p>Doanh thu gộp</p><h3>${renderMoney(summary.GrossRevenue || 0, 'sun')}</h3></div>
    <div class="report-card"><p>Đã hoàn thành</p><h3>${renderMoney(summary.CompletedRevenue || 0, 'mint')}</h3></div>
    <div class="report-card"><p>Đơn hủy</p><h3>${summary.CancelledOrders || 0}</h3></div>
  `;

  topItemsEl.innerHTML = (result.topItems || []).length
    ? result.topItems.map((item) => `<p>${item.ItemName}: ${item.SoldQty} món - ${renderMoney(item.Revenue, 'violet')}</p>`).join('')
    : '<p>Không có dữ liệu.</p>';
}

menuForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  menuMessageEl.textContent = '';

  const payload = {
    name: menuForm.name.value,
    category: menuForm.category.value,
    price: parseMoneyInput(menuForm.price.value),
    isAvailable: menuForm.isAvailable.checked
  };

  const id = menuForm.id.value;
  const url = id ? `/api/store/menu/${id}` : '/api/store/menu';
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

tableForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  tableMessageEl.textContent = '';

  const tableId = tableForm.id.value;
  const isEditMode = Boolean(tableId);
  let payload;

  if (isEditMode) {
    payload = {
      tableNumber: tableForm.tableNumber.value,
      qrToken: tableForm.qrToken.value,
      isActive: tableForm.isActive.checked
    };
  } else {
    const quantity = Number(tableForm.quantity.value);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      tableMessageEl.textContent = 'Số lượng bàn phải là số nguyên dương.';
      return;
    }

    payload = {
      quantity,
      isActive: tableForm.isActive.checked
    };
  }

  const url = isEditMode ? `/api/store/tables/${tableId}` : '/api/store/tables';
  const method = isEditMode ? 'PUT' : 'POST';

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  tableMessageEl.textContent = result.message;
  if (response.ok) {
    if (!isEditMode && Array.isArray(result.tables) && result.tables.length) {
      const createdNumbers = Array.isArray(result.createdTableNumbers) && result.createdTableNumbers.length
        ? result.createdTableNumbers
        : result.tables.map((table) => table.TableNumber);
      tableMessageEl.textContent = `Đã tạo thêm bàn: ${createdNumbers.join(', ')}.`;
      showToast(`Đã tạo thêm bàn: ${createdNumbers.join(', ')}.`, 'success');
    } else if (result.table && !isEditMode) {
      showToast(`Đã tạo bàn ${result.table.TableNumber} và sinh QR thành công.`, 'success');
    } else if (result.table && isEditMode) {
      showToast(`Đã cập nhật bàn ${result.table.TableNumber}.`, 'success');
    }
    resetTableForm();
    fetchTables();
  }
});

async function fetchOrders() {
  const qs = toQueryString(orderFilter);
  const { response, result: orders } = await fetchJsonNoCache(`/api/store/orders?${qs}`);

  if (!response.ok) {
    hasActiveOrders = false;
    ordersListEl.innerHTML = `<p>${orders.message || 'Không tải được đơn hàng.'}</p>`;
    if (ordersPaginationEl) ordersPaginationEl.innerHTML = '';
    return;
  }

  ordersListEl.innerHTML = '';
  if (!orders.length) {
    hasActiveOrders = false;
    ordersListEl.innerHTML = '<p>Chưa có đơn hàng.</p>';
    renderOrdersPagination(0);
    return;
  }

  hasActiveOrders = true;

  const sortedOrders = [...orders].sort((a, b) => {
    const pa = statusPriority[a.Status] || 99;
    const pb = statusPriority[b.Status] || 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime();
  });

  const totalItems = sortedOrders.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ORDERS_PAGE_SIZE));
  if (currentOrdersPage > totalPages) {
    currentOrdersPage = totalPages;
  }
  const startIndex = (currentOrdersPage - 1) * ORDERS_PAGE_SIZE;
  const paginatedOrders = sortedOrders.slice(startIndex, startIndex + ORDERS_PAGE_SIZE);

  paginatedOrders.forEach((order) => {
    const card = document.createElement('div');
    card.className = 'order-card order-row';
    const itemsText = order.items.map((item) => `${item.ItemName} x ${item.Quantity}`).join(', ');

    const statusActionsHtml = ['completed', 'cancelled'].includes(order.Status)
      ? `<div class="status-actions status-actions-inline status-actions-empty" aria-hidden="true"></div>`
      : `<div class="status-actions status-actions-inline" role="group" aria-label="Cập nhật trạng thái đơn #${order.Id}">
          ${renderStatusButtons(order)}
        </div>`;

    const paymentActionHtml = order.Status === 'completed' && !order.IsPaid
      ? `<button type="button" class="small" data-mark-paid="${order.Id}">Đã thanh toán</button>`
      : (order.IsPaid ? '<span class="badge">Đã thanh toán</span>' : '<span class="action-placeholder" aria-hidden="true"></span>');

    card.innerHTML = `
      <div class="order-row-main">
        <h4 class="order-line">#${order.Id} • Bàn ${order.TableNumber}</h4>
        <p class="order-line order-truncate"><strong>Món:</strong> ${itemsText || '-'}</p>
        <p class="order-line order-truncate"><strong>Ghi chú:</strong> ${order.Note || '-'}</p>
      </div>
      <div class="order-row-meta">
        <p class="order-line"><strong>Tổng:</strong> ${renderMoney(order.TotalAmount, 'sun')}</p>
        <p class="order-line"><strong>Trạng thái:</strong> <span class="status-pill status-${order.Status}">${statusMap[order.Status] || order.Status}</span></p>
      </div>
      ${statusActionsHtml}
      <div class="order-links">
        ${paymentActionHtml}
        <a class="admin-link" target="_blank" href="/admin/invoice/${order.Id}">In hóa đơn</a>
        <a class="admin-link" target="_blank" href="/api/admin/orders/${order.Id}/pdf">Tải PDF</a>
      </div>
    `;

    card.querySelectorAll('[data-order-status]').forEach((statusButton) => {
      statusButton.addEventListener('click', async () => {
        const nextStatus = statusButton.getAttribute('data-value');
        if (!nextStatus || nextStatus === order.Status) return;

      const updateRes = await fetch(`/api/store/orders/${order.Id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus })
      });

      const updateResult = await updateRes.json();
      if (!updateRes.ok) {
        alert(updateResult.message || 'Cập nhật thất bại');
        fetchOrders();
        return;
      }

        applyOrderStatusOnCard(card, nextStatus);
        showToast(`Đơn #${order.Id}: ${statusMap[nextStatus]}`);
        refreshOrdersAndReport();
      });
    });

    card.querySelectorAll('[data-mark-paid]').forEach((button) => {
      button.addEventListener('click', async () => {
        const updateRes = await fetch(`/api/store/orders/${order.Id}/paid`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' }
        });

        const updateResult = await updateRes.json();
        if (!updateRes.ok) {
          alert(updateResult.message || 'Không cập nhật được trạng thái thanh toán');
          return;
        }

        showToast(`Đơn #${order.Id} đã được đánh dấu thanh toán.`, 'success');
        refreshOrdersAndReport();
      });
    });

    ordersListEl.appendChild(card);
  });

  renderOrdersPagination(totalItems);
}

function connectRealtime() {
  if (typeof io !== 'function') {
    realtimeBadgeEl.textContent = 'Realtime: không khả dụng';
    return;
  }

  const socket = io();
  socket.on('connect', () => {
    storeSocketConnected = true;
    realtimeBadgeEl.textContent = 'Realtime: đã kết nối';
    if (hasActiveOrders) {
      refreshOrdersAndReport();
    }
  });
  socket.on('disconnect', () => {
    storeSocketConnected = false;
    realtimeBadgeEl.textContent = 'Realtime: mất kết nối, đang thử lại...';
  });
  socket.on('connect_error', () => {
    storeSocketConnected = false;
    realtimeBadgeEl.textContent = 'Realtime: lỗi kết nối, đang thử lại...';
  });
  socket.on('order:new', (payload) => {
    hasActiveOrders = true;
    showToast(`Đơn mới #${payload.orderId} - bàn ${payload.tableNumber}`, 'success');
    playNewOrderSound();
    refreshOrdersAndReport();
  });
  socket.on('order:status-updated', (payload) => {
    if (payload?.status) {
      showToast(`Đơn #${payload.orderId} đã đổi sang ${statusMap[payload.status] || payload.status}`);
      refreshOrdersAndReport();
    }
  });
  socket.on('order:paid', (payload) => {
    if (payload?.orderId) {
      showToast(`Đơn #${payload.orderId} đã được thanh toán.`, 'success');
      refreshOrdersAndReport();
    }
  });
}

function startStoreSyncFallback() {
  if (storeSyncTimer) {
    clearInterval(storeSyncTimer);
  }

  // Keep UI in sync even when websocket is unstable on some networks/devices.
  storeSyncTimer = setInterval(() => {
    if (storeSocketConnected) return;
    if (!hasActiveOrders) return;
    refreshOrdersAndReport();
  }, 4000);
}

function showTab(tabName) {
  tabButtons.forEach((button) => {
    const isActive = button.getAttribute('data-tab-btn') === tabName;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.getAttribute('data-tab-panel') === tabName;
    panel.classList.toggle('active', isActive);
    panel.hidden = !isActive;
  });

  if (tabName === 'menu' && !menuLoaded) {
    fetchMenu();
    menuLoaded = true;
  }

  if (tabName === 'tables' && !tablesLoaded) {
    fetchTables();
    tablesLoaded = true;
  }
}

function initTabs() {
  if (!tabButtons.length || !tabPanels.length) return;

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const tabName = button.getAttribute('data-tab-btn');
      if (!tabName) return;
      showTab(tabName);
    });
  });

  showTab('orders');
}

function applyDefaultDateFilter() {
  const today = getTodayIsoDate();
  orderFilter.from = today;
  orderFilter.to = today;
  currentOrdersPage = 1;
  if (orderFilterForm?.from) orderFilterForm.from.value = today;
  if (orderFilterForm?.to) orderFilterForm.to.value = today;
}

function applyOrderFilterFromForm() {
  orderFilter.q = orderFilterForm.q.value.trim();
  orderFilter.status = orderFilterForm.status.value;
  orderFilter.from = orderFilterForm.from.value;
  orderFilter.to = orderFilterForm.to.value;
  currentOrdersPage = 1;
  fetchOrders();
  fetchReport();
}

orderFilterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  applyOrderFilterFromForm();
});

orderFilterForm.status.addEventListener('change', () => {
  applyOrderFilterFromForm();
});

resetOrderFilterBtn.addEventListener('click', () => {
  orderFilterForm.reset();
  orderFilter.q = '';
  orderFilter.status = 'all';
  currentOrdersPage = 1;
  applyDefaultDateFilter();
  fetchOrders();
  fetchReport();
});

if (ordersPaginationEl) {
  ordersPaginationEl.addEventListener('click', (event) => {
    const target = event.target.closest('[data-order-page]');
    if (!target) return;

    const action = target.getAttribute('data-order-page');
    if (action === 'prev' && currentOrdersPage > 1) {
      currentOrdersPage -= 1;
      fetchOrders();
      return;
    }
    if (action === 'next') {
      currentOrdersPage += 1;
      fetchOrders();
      return;
    }

    const pageNumber = Number(action);
    if (Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber !== currentOrdersPage) {
      currentOrdersPage = pageNumber;
      fetchOrders();
    }
  });
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login';
});

if (editProfileBtn) {
  editProfileBtn.addEventListener('click', updateOwnProfile);
}

resetMenuFormBtn.addEventListener('click', resetMenuForm);
if (resetTableFormBtn) {
  resetTableFormBtn.addEventListener('click', resetTableForm);
}
if (refreshOrdersBtn) {
  refreshOrdersBtn.addEventListener('click', () => {
    refreshOrdersAndReport();
  });
}

if (printQrBtn) {
  printQrBtn.addEventListener('click', printAllQrs);
}

setTableFormMode(false);

ensureSession().then((ok) => {
  if (!ok) return;
  applyDefaultDateFilter();
  initMoneyInputField();
  initTabs();
  refreshOrdersAndReport();
  connectRealtime();
  startStoreSyncFallback();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hasActiveOrders) {
      refreshOrdersAndReport();
    }
  });
});
