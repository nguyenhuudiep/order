const adminUserBadgeEl = document.getElementById('admin-user-badge');
const logoutBtn = document.getElementById('logout-btn');
const editProfileBtn = document.getElementById('edit-profile-btn');
const realtimeBadgeEl = document.getElementById('realtime-badge');
const toastContainerEl = document.getElementById('toast-container');

const storeForm = document.getElementById('store-form');
const resetStoreFormBtn = document.getElementById('reset-store-form');
const storeMessageEl = document.getElementById('store-message');
const storesListEl = document.getElementById('stores-list');

const storeUserForm = document.getElementById('store-user-form');
const storeUserMessageEl = document.getElementById('store-user-message');
const storeUsersListEl = document.getElementById('store-users-list');
const storeUserStoreSelect = document.getElementById('store-user-store');

const tableFilterForm = document.getElementById('table-filter-form');
const tableMessageEl = document.getElementById('table-message');
const tableStoreSelect = document.getElementById('table-store');
const tablesListEl = document.getElementById('tables-list');

let stores = [];
let currentAdminUser = null;

function withNoCache(url) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_ts=${Date.now()}`;
}

async function fetchJsonNoCache(url) {
  const response = await fetch(withNoCache(url), {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache'
    }
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
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

async function ensureSession() {
  const response = await fetch('/api/admin/session', {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache'
    }
  });
  if (!response.ok) {
    window.location.href = '/admin/login';
    return false;
  }

  const result = await response.json();
  if (result.user.role !== 'platform') {
    window.location.href = '/admin';
    return false;
  }

  currentAdminUser = result.user;
  adminUserBadgeEl.textContent = `${result.user.fullName} (Hệ thống)`;
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
    adminUserBadgeEl.textContent = `${currentAdminUser.fullName} (Hệ thống)`;
    showToast(result.message || 'Cập nhật tài khoản thành công.', 'success');
  } catch (error) {
    showToast(error.message || 'Không cập nhật được tài khoản.');
  }
}

function fillStoreSelects() {
  const options = stores.map((s) => `<option value="${s.Id}">${s.Name}${s.Phone ? ` - ${s.Phone}` : ''}</option>`).join('');
  storeUserStoreSelect.innerHTML = options;
  tableStoreSelect.innerHTML = options;
}

function resetStoreForm() {
  storeForm.reset();
  storeForm.id.value = '';
  storeForm.isActive.checked = true;
}

async function fetchStores() {
  const { response, result: data } = await fetchJsonNoCache('/api/platform/stores');

  if (!response.ok) {
    storesListEl.innerHTML = `<p>${data.message || 'Không tải được cửa hàng.'}</p>`;
    return;
  }

  stores = data;
  fillStoreSelects();

  storesListEl.innerHTML = data.map((store) => `
    <div class="item-card">
      <div>
        <h4>${store.Name}</h4>
        <p>SĐT: ${store.Phone || '-'} | ${store.Address || '-'} | ${store.IsActive ? 'Đang hoạt động' : 'Ngưng hoạt động'}</p>
      </div>
      <div class="row-actions">
        <button data-edit="${store.Id}">Sửa</button>
        <button data-table="${store.Id}" class="secondary">Xem bàn</button>
        <button data-delete-store="${store.Id}" class="secondary">Xóa</button>
      </div>
    </div>
  `).join('');

  storesListEl.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const store = stores.find((s) => String(s.Id) === btn.dataset.edit);
      if (!store) return;
      storeForm.id.value = store.Id;
      storeForm.name.value = store.Name;
      storeForm.phone.value = store.Phone || '';
      storeForm.address.value = store.Address || '';
      storeForm.isActive.checked = Boolean(store.IsActive);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  storesListEl.querySelectorAll('[data-table]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      tableStoreSelect.value = btn.dataset.table;
      await fetchTables(btn.dataset.table);
      showToast('Đã tải danh sách bàn của cửa hàng được chọn.');
    });
  });

  storesListEl.querySelectorAll('[data-delete-store]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const storeId = btn.getAttribute('data-delete-store');
      const store = stores.find((s) => String(s.Id) === String(storeId));
      const ok = window.confirm(`Xóa cửa hàng ${store?.Name || ''}?\nToàn bộ tài khoản cửa hàng, bàn, menu và đơn của cửa hàng này sẽ bị xóa.`);
      if (!ok) return;

      const response = await fetch(`/api/platform/stores/${storeId}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));
      showToast(result.message || (response.ok ? 'Đã xóa cửa hàng.' : 'Không xóa được cửa hàng.'));

      if (response.ok) {
        if (String(storeForm.id.value) === String(storeId)) {
          resetStoreForm();
        }
        await fetchStores();
        await fetchStoreUsers();
      }
    });
  });

  if (data.length > 0) {
    await fetchTables(data[0].Id);
  } else {
    tablesListEl.innerHTML = '<p>Chưa có cửa hàng để hiển thị bàn.</p>';
  }
}

storeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  storeMessageEl.textContent = '';

  const payload = {
    name: storeForm.name.value,
    phone: storeForm.phone.value,
    address: storeForm.address.value,
    isActive: storeForm.isActive.checked
  };

  const id = storeForm.id.value;
  const url = id ? `/api/platform/stores/${id}` : '/api/platform/stores';
  const method = id ? 'PUT' : 'POST';

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  storeMessageEl.textContent = result.message;
  if (response.ok) {
    resetStoreForm();
    await fetchStores();
  }
});

async function fetchTables(storeId) {
  const { response, result: tables } = await fetchJsonNoCache(`/api/platform/stores/${storeId}/tables`);

  if (!response.ok) {
    tablesListEl.innerHTML = `<p>${tables.message || 'Không tải được bàn.'}</p>`;
    return;
  }

  if (!tables.length) {
    tablesListEl.innerHTML = '<p>Chưa có bàn trong cửa hàng này.</p>';
    return;
  }

  const origin = window.location.origin;
  tablesListEl.innerHTML = tables.map((table) => `
    <div class="order-card">
      <h4>Bàn ${table.TableNumber}</h4>
      <p><strong>QR Token:</strong> ${table.QrToken}</p>
      <p><strong>Link quét:</strong> ${table.orderLink || `${origin}/scan/${table.QrToken}`}</p>
      <p><strong>Trạng thái:</strong> ${table.IsActive ? 'Hoạt động' : 'Ngưng'}</p>
      <div class="qr-preview-wrap">
        <img class="qr-preview" src="${table.qrImageDataUrl}" alt="QR bàn ${table.TableNumber}" />
      </div>
    </div>
  `).join('');
}

tableFilterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  tableMessageEl.textContent = '';
  const storeId = tableStoreSelect.value;
  if (!storeId) {
    tableMessageEl.textContent = 'Vui lòng chọn cửa hàng.';
    return;
  }
  await fetchTables(storeId);
  tableMessageEl.textContent = 'Đã tải danh sách bàn.';
});

tableStoreSelect.addEventListener('change', () => {
  if (tableStoreSelect.value) fetchTables(tableStoreSelect.value);
});

async function fetchStoreUsers() {
  const { response, result: users } = await fetchJsonNoCache('/api/platform/store-users');

  if (!response.ok) {
    storeUsersListEl.innerHTML = `<p>${users.message || 'Không tải được tài khoản cửa hàng.'}</p>`;
    return;
  }

  if (!users.length) {
    storeUsersListEl.innerHTML = '<p>Chưa có tài khoản cửa hàng.</p>';
    return;
  }

  storeUsersListEl.innerHTML = users.map((user) => `
    <div class="item-card">
      <div>
        <h4>${user.FullName} (${user.Username})</h4>
        <p>Cửa hàng: ${user.StoreName || '-'} | ${user.IsActive ? 'Đang hoạt động' : 'Đã khóa'}</p>
      </div>
      <div class="row-actions">
        <button data-toggle="${user.Id}" data-active="${user.IsActive ? '1' : '0'}" class="secondary">${user.IsActive ? 'Khóa' : 'Mở khóa'}</button>
          <button data-reset-password="${user.Id}" class="btn btn-outline">Đổi mật khẩu</button>
      </div>
    </div>
  `).join('');

  storeUsersListEl.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nextActive = btn.dataset.active !== '1';
      const responseToggle = await fetch(`/api/platform/store-users/${btn.dataset.toggle}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: nextActive })
      });
      const result = await responseToggle.json();
      showToast(result.message || 'Đã cập nhật trạng thái tài khoản.');
      if (responseToggle.ok) fetchStoreUsers();
    });
  });

  storeUsersListEl.querySelectorAll('[data-reset-password]').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = button.getAttribute('data-reset-password');
      const password = window.prompt('Nhập mật khẩu mới (ít nhất 6 ký tự):');
      if (password === null) {
        return;
      }

      if (password.trim().length < 6) {
        showToast('Mật khẩu phải có ít nhất 6 ký tự.');
        return;
      }

      try {
        const response = await fetch(`/api/platform/store-users/${userId}/password`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password.trim() })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.message || 'Không đổi được mật khẩu');
        }

        showToast(payload.message || 'Đổi mật khẩu thành công.');
      } catch (error) {
        showToast(error.message || 'Không đổi được mật khẩu');
      }
    });
  });
}

storeUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  storeUserMessageEl.textContent = '';

  const payload = {
    username: storeUserForm.username.value,
    password: storeUserForm.password.value,
    fullName: storeUserForm.fullName.value,
    storeId: Number(storeUserForm.storeId.value),
    isActive: storeUserForm.isActive.checked
  };

  const response = await fetch('/api/platform/store-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  storeUserMessageEl.textContent = result.message;
  if (response.ok) {
    storeUserForm.reset();
    storeUserForm.isActive.checked = true;
    await fetchStoreUsers();
  }
});

function connectRealtime() {
  if (typeof io !== 'function') {
    realtimeBadgeEl.textContent = 'Realtime: không khả dụng';
    return;
  }

  const socket = io();
  socket.on('connect', () => {
    realtimeBadgeEl.textContent = 'Realtime: đã kết nối';
  });
  socket.on('disconnect', () => {
    realtimeBadgeEl.textContent = 'Realtime: mất kết nối';
  });

  socket.on('platform:order-new', (payload) => {
    showToast(`Đơn mới #${payload.orderId} - ${payload.storeName} - bàn ${payload.tableNumber}`, 'success');
  });
}

resetStoreFormBtn.addEventListener('click', resetStoreForm);
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login';
});

if (editProfileBtn) {
  editProfileBtn.addEventListener('click', updateOwnProfile);
}

ensureSession().then((ok) => {
  if (!ok) return;
  fetchStores();
  fetchStoreUsers();
  connectRealtime();
});
