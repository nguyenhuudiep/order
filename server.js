const fs = require('fs');
const dotenv = require('dotenv');
const http = require('http');
const express = require('express');
const path = require('path');
const sql = require('mssql');
const session = require('express-session');
const bcrypt = require('bcrypt');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const ROOT_DIR = __dirname;
const nodeEnv = String(process.env.NODE_ENV || 'development').trim();
const customEnvFile = String(process.env.ENV_FILE || '').trim();
const loadedEnvFiles = [];

const envCandidates = customEnvFile
  ? [customEnvFile]
  : [
      `.env.${nodeEnv}.local`,
      `.env.${nodeEnv}`,
      '.env.local',
      '.env'
    ];

envCandidates.forEach((candidate) => {
  const envPath = path.isAbsolute(candidate) ? candidate : path.join(ROOT_DIR, candidate);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
    loadedEnvFiles.push(envPath);
  }
});

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = Number(process.env.PORT || 5100);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const ORDER_STATUSES = ['pending', 'preparing', 'completed', 'cancelled'];
const STATUS_MAP = {
  pending: 'Chờ xác nhận',
  preparing: 'Đang chuẩn bị',
  completed: 'Hoàn thành',
  cancelled: 'Đã hủy'
};

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: Number(process.env.DB_PORT || 1433),
  options: {
    encrypt: false,
    trustServerCertificate: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

function getMissingRequiredEnvVars() {
  const requiredEnvVars = ['DB_USER', 'DB_PASSWORD', 'DB_SERVER', 'DB_DATABASE', 'SESSION_SECRET'];
  return requiredEnvVars.filter((key) => !String(process.env[key] || '').trim());
}

let pool;
let compatibilityReadyPromise;

async function ensureDatabaseCompatibility(connection) {
  if (compatibilityReadyPromise) {
    return compatibilityReadyPromise;
  }

  compatibilityReadyPromise = connection.request().query(`
    IF COL_LENGTH('dbo.Orders', 'IsPaid') IS NULL
    BEGIN
      ALTER TABLE dbo.Orders ADD IsPaid BIT NOT NULL CONSTRAINT DF_Orders_IsPaid DEFAULT 0;
    END

    IF COL_LENGTH('dbo.Orders', 'PaidAt') IS NULL
    BEGIN
      ALTER TABLE dbo.Orders ADD PaidAt DATETIME2 NULL;
    END

    IF COL_LENGTH('dbo.Stores', 'Phone') IS NULL
    BEGIN
      ALTER TABLE dbo.Stores ADD Phone NVARCHAR(30) NULL;
    END
  `);

  await compatibilityReadyPromise;
}

async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(dbConfig);
  await ensureDatabaseCompatibility(pool);
  return pool;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.on('connection', (socket) => {
  const adminUser = socket.request.session?.adminUser;
  const tableToken = String(socket.handshake.query?.tableToken || '').trim();

  if (tableToken) {
    socket.join(`table-${tableToken}`);
  }

  if (adminUser) {
    if (adminUser.role === 'platform') {
      socket.join('platform-room');
    }
    if (adminUser.storeId) {
      socket.join(`store-${adminUser.storeId}`);
    }
  }
});

function emitOrderCreated(payload) {
  io.to(`store-${payload.storeId}`).emit('order:new', payload);
  io.to('platform-room').emit('platform:order-new', payload);
}

function emitOrderStatusUpdated(payload) {
  io.to(`store-${payload.storeId}`).emit('order:status-updated', payload);
  io.to('platform-room').emit('platform:order-status-updated', payload);
  if (payload.tableToken) {
    io.to(`table-${payload.tableToken}`).emit('table:order-changed', payload);
  }
}

function emitOrderCreatedForTable(payload) {
  if (payload.tableToken) {
    io.to(`table-${payload.tableToken}`).emit('table:order-changed', payload);
  }
}

function emitOrderPaidForTable(payload) {
  io.to(`store-${payload.storeId}`).emit('order:paid', payload);
  io.to('platform-room').emit('platform:order-paid', payload);
  if (payload.tableToken) {
    io.to(`table-${payload.tableToken}`).emit('table:order-changed', payload);
  }
}

function normalizeDateInput(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildOrdersFilterQuery(request, queryParams, alias = 'o') {
  const filters = ['1 = 1'];

  if (queryParams.status && queryParams.status !== 'all') {
    if (!ORDER_STATUSES.includes(queryParams.status)) {
      throw new Error('TRANG_THAI_KHONG_HOP_LE');
    }
    request.input('status', sql.NVarChar(30), queryParams.status);
    filters.push(`${alias}.Status = @status`);
  }

  if (queryParams.q) {
    request.input('keyword', sql.NVarChar(120), `%${queryParams.q}%`);
    filters.push(`(${alias}.CustomerName LIKE @keyword OR CAST(${alias}.Id AS NVARCHAR(30)) LIKE @keyword)`);
  }

  const fromDate = normalizeDateInput(queryParams.from);
  if (fromDate) {
    request.input('fromDate', sql.DateTime2, fromDate);
    filters.push(`${alias}.CreatedAt >= @fromDate`);
  }

  const toDate = normalizeDateInput(queryParams.to);
  if (toDate) {
    request.input('toDate', sql.DateTime2, toDate);
    filters.push(`${alias}.CreatedAt < DATEADD(day, 1, @toDate)`);
  }

  return filters.join(' AND ');
}

function requireAuth(req, res, next) {
  if (!req.session.adminUser) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ message: 'Vui lòng đăng nhập quản trị.' });
    }
    return res.redirect('/admin/login');
  }
  return next();
}

function requirePlatform(req, res, next) {
  if (!req.session.adminUser || req.session.adminUser.role !== 'platform') {
    return res.status(403).json({ message: 'Bạn không có quyền truy cập tính năng này.' });
  }
  return next();
}

function requireStore(req, res, next) {
  if (!req.session.adminUser || req.session.adminUser.role !== 'store') {
    return res.status(403).json({ message: 'Bạn không có quyền truy cập tính năng này.' });
  }
  return next();
}

function canAccessStore(user, storeId) {
  if (!user) return false;
  if (user.role === 'platform') return true;
  return user.role === 'store' && Number(user.storeId) === Number(storeId);
}

function buildInternalStoreCode() {
  return `STORE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function buildOrderLink(req, qrToken) {
  return `${req.protocol}://${req.get('host')}/scan/${encodeURIComponent(qrToken)}`;
}

async function mapTableWithQr(req, table) {
  const orderLink = buildOrderLink(req, table.QrToken);
  const qrImageDataUrl = await QRCode.toDataURL(orderLink, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280
  });

  return {
    ...table,
    orderLink,
    qrImageDataUrl
  };
}

async function getOrderDetailById(orderId) {
  const connection = await getPool();
  const orderResult = await connection.request()
    .input('orderId', sql.Int, orderId)
    .query(`
      SELECT TOP 1
        o.Id,
        o.StoreId,
        o.TableId,
        o.CustomerName,
        o.Note,
        o.TotalAmount,
        o.Status,
        o.CreatedAt,
        s.Name AS StoreName,
        t.TableNumber
      FROM dbo.Orders o
      INNER JOIN dbo.Stores s ON o.StoreId = s.Id
      INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
      WHERE o.Id = @orderId
    `);

  const order = orderResult.recordset[0];
  if (!order) {
    return null;
  }

  const itemsResult = await connection.request()
    .input('orderId', sql.Int, orderId)
    .query(`
      SELECT ItemName, Quantity, UnitPrice
      FROM dbo.OrderItems
      WHERE OrderId = @orderId
      ORDER BY Id ASC
    `);

  return { ...order, items: itemsResult.recordset };
}

app.get('/', (_req, res) => {
  res.render('customer');
});

app.get('/scan/:token', (req, res) => {
  res.redirect(`/?table=${encodeURIComponent(req.params.token)}`);
});

app.get('/admin/login', (req, res) => {
  if (req.session.adminUser) {
    return res.redirect('/admin');
  }
  return res.render('admin-login');
});

app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }

  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) {
    return next();
  }

  if (req.path === '/' || req.path === '/admin/login' || req.path.startsWith('/scan/')) {
    return next();
  }

  if (req.session.adminUser) {
    return next();
  }

  return res.redirect('/admin/login');
});

app.get('/admin', requireAuth, (req, res) => {
  if (req.session.adminUser.role === 'platform') {
    return res.render('platform-admin');
  }
  return res.render('store-admin');
});

app.get('/admin/invoice/:id', requireAuth, (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) {
    return res.status(400).send('ID đơn hàng không hợp lệ');
  }
  return res.render('invoice', { orderId });
});

app.get('/api/admin/session', (req, res) => {
  if (!req.session.adminUser) {
    return res.status(401).json({ loggedIn: false });
  }

  return res.json({
    loggedIn: true,
    user: req.session.adminUser
  });
});

app.patch('/api/admin/profile', requireAuth, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const fullName = String(req.body.fullName || '').trim();
  const passwordText = String(req.body.password || '').trim();

  if (!username || !fullName) {
    return res.status(400).json({ message: 'Tên đăng nhập và họ tên không được để trống.' });
  }

  if (passwordText && passwordText.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
  }

  try {
    const connection = await getPool();
    const request = connection.request()
      .input('userId', sql.Int, req.session.adminUser.id)
      .input('username', sql.NVarChar(60), username)
      .input('fullName', sql.NVarChar(120), fullName);

    let setPasswordQuery = '';
    if (passwordText) {
      const passwordHash = await bcrypt.hash(passwordText, 10);
      request.input('passwordHash', sql.NVarChar(255), passwordHash);
      setPasswordQuery = ', PasswordHash = @passwordHash';
    }

    const result = await request.query(`
      UPDATE dbo.AdminUsers
      SET Username = @username,
          FullName = @fullName
          ${setPasswordQuery}
      WHERE Id = @userId
    `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản hiện tại.' });
    }

    req.session.adminUser.username = username;
    req.session.adminUser.fullName = fullName;

    return res.json({
      message: 'Cập nhật thông tin tài khoản thành công.',
      user: req.session.adminUser
    });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ message: 'Tên đăng nhập đã tồn tại.' });
    }

    console.error(error);
    return res.status(500).json({ message: 'Không cập nhật được thông tin tài khoản.' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu.' });
  }

  try {
    const connection = await getPool();
    const userResult = await connection.request()
      .input('username', sql.NVarChar(60), username)
      .query(`
        SELECT TOP 1 Id, Username, PasswordHash, FullName, Role, StoreId, IsActive
        FROM dbo.AdminUsers
        WHERE Username = @username
      `);

    const user = userResult.recordset[0];
    if (!user || !user.IsActive) {
      return res.status(401).json({ message: 'Sai tài khoản hoặc mật khẩu.' });
    }

    const matched = await bcrypt.compare(password, user.PasswordHash);
    if (!matched) {
      return res.status(401).json({ message: 'Sai tài khoản hoặc mật khẩu.' });
    }

    req.session.adminUser = {
      id: user.Id,
      username: user.Username,
      fullName: user.FullName,
      role: user.Role,
      storeId: user.StoreId || null
    };

    return res.json({ message: 'Đăng nhập thành công.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không thể đăng nhập lúc này.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Đã đăng xuất.' });
  });
});

app.get('/api/table-context', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({ message: 'Thiếu mã QR của bàn.' });
  }

  try {
    const connection = await getPool();
    const contextResult = await connection.request()
      .input('token', sql.NVarChar(120), token)
      .query(`
        SELECT TOP 1
          t.Id AS TableId,
          t.TableNumber,
          t.QrToken,
          t.StoreId,
          s.Name AS StoreName,
          s.Address AS StoreAddress
        FROM dbo.StoreTables t
        INNER JOIN dbo.Stores s ON t.StoreId = s.Id
        WHERE t.QrToken = @token
          AND t.IsActive = 1
          AND s.IsActive = 1
      `);

    const tableContext = contextResult.recordset[0];
    if (!tableContext) {
      return res.status(404).json({ message: 'Mã QR không hợp lệ hoặc đã ngưng hoạt động.' });
    }

    return res.json(tableContext);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được thông tin bàn.' });
  }
});

app.get('/api/menu/by-table', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({ message: 'Thiếu mã QR của bàn.' });
  }

  try {
    const connection = await getPool();
    const tableResult = await connection.request()
      .input('token', sql.NVarChar(120), token)
      .query(`
        SELECT TOP 1 StoreId
        FROM dbo.StoreTables
        WHERE QrToken = @token
          AND IsActive = 1
      `);

    const table = tableResult.recordset[0];
    if (!table) {
      return res.status(404).json({ message: 'Mã QR không hợp lệ hoặc đã ngưng hoạt động.' });
    }

    const menuResult = await connection.request()
      .input('storeId', sql.Int, table.StoreId)
      .query(`
        SELECT Id, Name, Category, Price, IsAvailable
        FROM dbo.MenuItems
        WHERE StoreId = @storeId
          AND IsAvailable = 1
        ORDER BY Category, Name
      `);

    return res.json(menuResult.recordset);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Không lấy được danh sách món.' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { tableToken, note, items } = req.body;

  if (!tableToken || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Dữ liệu đơn hàng không hợp lệ.' });
  }

  const sanitizedItems = items
    .map((item) => ({
      menuItemId: Number(item.menuItemId),
      quantity: Number(item.quantity)
    }))
    .filter((item) => Number.isInteger(item.menuItemId) && Number.isInteger(item.quantity) && item.quantity > 0);

  if (sanitizedItems.length === 0) {
    return res.status(400).json({ message: 'Danh sách món không hợp lệ.' });
  }

  const connection = await getPool();
  const transaction = new sql.Transaction(connection);
  let startedTransaction = false;

  try {
    await transaction.begin();
    startedTransaction = true;

    const tableResult = await new sql.Request(transaction)
      .input('tableToken', sql.NVarChar(120), tableToken)
      .query(`
        SELECT TOP 1 t.Id AS TableId, t.StoreId, t.TableNumber, s.Name AS StoreName
        FROM dbo.StoreTables t
        INNER JOIN dbo.Stores s ON t.StoreId = s.Id
        WHERE t.QrToken = @tableToken
          AND t.IsActive = 1
          AND s.IsActive = 1
      `);

    const table = tableResult.recordset[0];
    if (!table) {
      throw new Error('BAN_KHONG_HOP_LE');
    }

    let totalAmount = 0;
    const detailedItems = [];

    for (const item of sanitizedItems) {
      const menuResult = await new sql.Request(transaction)
        .input('menuItemId', sql.Int, item.menuItemId)
        .input('storeId', sql.Int, table.StoreId)
        .query(`
          SELECT Id, Name, Price, IsAvailable
          FROM dbo.MenuItems
          WHERE Id = @menuItemId
            AND StoreId = @storeId
        `);

      const menuItem = menuResult.recordset[0];
      if (!menuItem || !menuItem.IsAvailable) {
        throw new Error('MON_KHONG_HOP_LE');
      }

      const lineTotal = Number(menuItem.Price) * item.quantity;
      totalAmount += lineTotal;

      detailedItems.push({
        menuItemId: menuItem.Id,
        itemName: menuItem.Name,
        unitPrice: Number(menuItem.Price),
        quantity: item.quantity
      });
    }

    const orderInsert = await new sql.Request(transaction)
      .input('storeId', sql.Int, table.StoreId)
      .input('tableId', sql.Int, table.TableId)
      .input('customerName', sql.NVarChar(120), `Khách tại bàn ${table.TableNumber}`)
      .input('note', sql.NVarChar(500), note || null)
      .input('totalAmount', sql.Decimal(18, 2), totalAmount)
      .query(`
        INSERT INTO dbo.Orders (StoreId, TableId, CustomerName, CustomerPhone, DeliveryAddress, Note, TotalAmount, Status)
        OUTPUT INSERTED.Id
        VALUES (@storeId, @tableId, @customerName, NULL, NULL, @note, @totalAmount, N'pending')
      `);

    const orderId = orderInsert.recordset[0].Id;

    for (const item of detailedItems) {
      await new sql.Request(transaction)
        .input('orderId', sql.Int, orderId)
        .input('menuItemId', sql.Int, item.menuItemId)
        .input('quantity', sql.Int, item.quantity)
        .input('unitPrice', sql.Decimal(18, 2), item.unitPrice)
        .input('itemName', sql.NVarChar(150), item.itemName)
        .query(`
          INSERT INTO dbo.OrderItems (OrderId, MenuItemId, Quantity, UnitPrice, ItemName)
          VALUES (@orderId, @menuItemId, @quantity, @unitPrice, @itemName)
        `);
    }

    await transaction.commit();

    emitOrderCreated({
      orderId,
      storeId: table.StoreId,
      storeName: table.StoreName,
      tableNumber: table.TableNumber,
      customerName: `Khách tại bàn ${table.TableNumber}`
    });

    emitOrderCreatedForTable({
      orderId,
      storeId: table.StoreId,
      tableNumber: table.TableNumber,
      tableToken,
      event: 'order-created'
    });

    res.status(201).json({
      message: `Đặt món thành công cho bàn ${table.TableNumber}.`,
      orderId,
      tableNumber: table.TableNumber
    });
  } catch (error) {
    if (startedTransaction) {
      await transaction.rollback();
    }

    if (error.message === 'MON_KHONG_HOP_LE') {
      return res.status(400).json({ message: 'Món không tồn tại hoặc tạm hết.' });
    }

    if (error.message === 'BAN_KHONG_HOP_LE') {
      return res.status(400).json({ message: 'Mã QR bàn không hợp lệ hoặc đã ngưng hoạt động.' });
    }

    console.error(error);
    res.status(500).json({ message: 'Không thể tạo đơn hàng.' });
  }
});

app.get('/api/orders/:id/status', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const orderId = Number(req.params.id);
  const tableToken = String(req.query.tableToken || '').trim();

  if (!Number.isInteger(orderId) || !tableToken) {
    return res.status(400).json({ message: 'Thiếu mã đơn hoặc mã bàn.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('orderId', sql.Int, orderId)
      .input('tableToken', sql.NVarChar(120), tableToken)
      .query(`
        SELECT TOP 1 o.Id, o.Status, o.CreatedAt, t.TableNumber, o.IsPaid
        FROM dbo.Orders o
        INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
        WHERE o.Id = @orderId
          AND t.QrToken = @tableToken
      `);

    const order = result.recordset[0];
    if (!order) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
    }

    return res.json({
      orderId: order.Id,
      status: order.Status,
      statusText: STATUS_MAP[order.Status] || order.Status,
      tableNumber: order.TableNumber,
      isPaid: Boolean(order.IsPaid),
      createdAt: order.CreatedAt
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được trạng thái đơn.' });
  }
});

app.get('/api/orders/history', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const tableToken = String(req.query.tableToken || '').trim();

  if (!tableToken) {
    return res.status(400).json({ message: 'Thiếu mã bàn.' });
  }

  try {
    const connection = await getPool();
    const ordersResult = await connection.request()
      .input('tableToken', sql.NVarChar(120), tableToken)
      .query(`
        SELECT o.Id, o.Note, o.TotalAmount, o.Status, o.CreatedAt
        FROM dbo.Orders o
        INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
        WHERE t.QrToken = @tableToken
          AND ISNULL(o.IsPaid, 0) = 0
          AND o.Status <> 'cancelled'
        ORDER BY o.CreatedAt DESC
      `);

    const itemsResult = await connection.request()
      .input('tableToken', sql.NVarChar(120), tableToken)
      .query(`
        SELECT oi.OrderId, oi.ItemName, oi.Quantity, oi.UnitPrice
        FROM dbo.OrderItems oi
        INNER JOIN dbo.Orders o ON oi.OrderId = o.Id
        INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
        WHERE t.QrToken = @tableToken
          AND ISNULL(o.IsPaid, 0) = 0
          AND o.Status <> 'cancelled'
        ORDER BY oi.Id ASC
      `);

      const summaryResult = await connection.request()
        .input('tableToken', sql.NVarChar(120), tableToken)
        .query(`
          SELECT ISNULL(SUM(o.TotalAmount), 0) AS OutstandingTotal
          FROM dbo.Orders o
          INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
          WHERE t.QrToken = @tableToken
            AND ISNULL(o.IsPaid, 0) = 0
            AND o.Status <> 'cancelled'
        `);

    const itemsByOrderId = itemsResult.recordset.reduce((acc, item) => {
      if (!acc[item.OrderId]) acc[item.OrderId] = [];
      acc[item.OrderId].push(item);
      return acc;
    }, {});

    const orders = ordersResult.recordset.map((order) => ({
      ...order,
      statusText: STATUS_MAP[order.Status] || order.Status,
      items: itemsByOrderId[order.Id] || []
    }));

    return res.json({
      outstandingTotal: Number(summaryResult.recordset[0]?.OutstandingTotal || 0),
      orders
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được lịch sử đơn.' });
  }
});

app.get('/api/store/orders', requireStore, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const connection = await getPool();
    const orderRequest = connection.request();
    const whereClause = buildOrdersFilterQuery(orderRequest, req.query, 'o');
    orderRequest.input('storeId', sql.Int, req.session.adminUser.storeId);

    const ordersResult = await orderRequest.query(`
      SELECT o.Id, o.CustomerName, o.Note, o.TotalAmount, o.Status, o.CreatedAt, o.IsPaid, o.PaidAt, t.TableNumber
      FROM dbo.Orders o
      INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
      WHERE ${whereClause}
        AND o.StoreId = @storeId
      ORDER BY o.CreatedAt DESC
    `);

    const itemsRequest = connection.request();
    const itemWhereClause = buildOrdersFilterQuery(itemsRequest, req.query, 'o');
    itemsRequest.input('storeId', sql.Int, req.session.adminUser.storeId);
    const itemsResult = await itemsRequest.query(`
      SELECT oi.OrderId, oi.ItemName, oi.Quantity, oi.UnitPrice
      FROM dbo.OrderItems oi
      INNER JOIN dbo.Orders o ON oi.OrderId = o.Id
      WHERE ${itemWhereClause}
        AND o.StoreId = @storeId
      ORDER BY oi.Id ASC
    `);

    const itemsByOrderId = itemsResult.recordset.reduce((acc, item) => {
      if (!acc[item.OrderId]) acc[item.OrderId] = [];
      acc[item.OrderId].push(item);
      return acc;
    }, {});

    const orders = ordersResult.recordset.map((order) => ({
      ...order,
      items: itemsByOrderId[order.Id] || []
    }));

    res.json(orders);
  } catch (error) {
    if (error.message === 'TRANG_THAI_KHONG_HOP_LE') {
      return res.status(400).json({ message: 'Trạng thái không hợp lệ.' });
    }
    console.error(error);
    res.status(500).json({ message: 'Không lấy được danh sách đơn.' });
  }
});

app.get('/api/admin/orders/:id', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) {
    return res.status(400).json({ message: 'ID đơn hàng không hợp lệ.' });
  }

  try {
    const order = await getOrderDetailById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
    }
    if (!canAccessStore(req.session.adminUser, order.StoreId)) {
      return res.status(403).json({ message: 'Bạn không có quyền truy cập đơn này.' });
    }

    return res.json(order);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được chi tiết đơn.' });
  }
});

app.get('/api/admin/orders/:id/pdf', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) {
    return res.status(400).json({ message: 'ID đơn hàng không hợp lệ.' });
  }

  try {
    const order = await getOrderDetailById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
    }
    if (!canAccessStore(req.session.adminUser, order.StoreId)) {
      return res.status(403).json({ message: 'Bạn không có quyền truy cập đơn này.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="hoa-don-${order.Id}.pdf"`);

    const doc = new PDFDocument({ margin: 42 });
    doc.pipe(res);

    doc.fontSize(18).text('HÓA ĐƠN BÁN HÀNG', { align: 'center' });
    doc.moveDown(0.8);
    doc.fontSize(11);
    doc.text(`Cửa hàng: ${order.StoreName}`);
    doc.text(`Bàn: ${order.TableNumber}`);
    doc.text(`Mã đơn: #${order.Id}`);
    doc.text(`Khách hàng: ${order.CustomerName}`);
    doc.text(`Trạng thái: ${STATUS_MAP[order.Status] || order.Status}`);
    doc.text(`Thời gian: ${new Date(order.CreatedAt).toLocaleString('vi-VN')}`);
    doc.text(`Ghi chú: ${order.Note || '-'}`);
    doc.moveDown(1);

    doc.fontSize(12).text('Chi tiết món:', { underline: true });
    doc.moveDown(0.5);

    order.items.forEach((item, index) => {
      const lineTotal = Number(item.Quantity) * Number(item.UnitPrice);
      doc.fontSize(10).text(
        `${index + 1}. ${item.ItemName} | SL: ${item.Quantity} | Đơn giá: ${Number(item.UnitPrice).toLocaleString('vi-VN')} VND | Thành tiền: ${lineTotal.toLocaleString('vi-VN')} VND`
      );
    });

    doc.moveDown(1);
    doc.fontSize(13).text(`Tổng thanh toán: ${Number(order.TotalAmount).toLocaleString('vi-VN')} VND`, {
      align: 'right'
    });

    doc.end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Không tạo được hóa đơn PDF.' });
  }
});

app.get('/api/store/reports/summary', requireStore, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const connection = await getPool();

    const summaryRequest = connection.request();
    const whereClause = buildOrdersFilterQuery(summaryRequest, req.query, 'o');
    summaryRequest.input('storeId', sql.Int, req.session.adminUser.storeId);
    const summaryResult = await summaryRequest.query(`
      SELECT
        COUNT(*) AS TotalOrders,
        SUM(CASE WHEN ISNULL(o.IsPaid, 0) = 1 THEN o.TotalAmount ELSE 0 END) AS GrossRevenue,
        SUM(CASE WHEN ISNULL(o.IsPaid, 0) = 1 THEN o.TotalAmount ELSE 0 END) AS CompletedRevenue,
        SUM(CASE WHEN o.Status = 'cancelled' THEN 1 ELSE 0 END) AS CancelledOrders
      FROM dbo.Orders o
      WHERE ${whereClause}
        AND o.StoreId = @storeId
    `);

    const statusRequest = connection.request();
    const statusWhereClause = buildOrdersFilterQuery(statusRequest, req.query, 'o');
    statusRequest.input('storeId', sql.Int, req.session.adminUser.storeId);
    const statusResult = await statusRequest.query(`
      SELECT o.Status, COUNT(*) AS Total
      FROM dbo.Orders o
      WHERE ${statusWhereClause}
        AND o.StoreId = @storeId
      GROUP BY o.Status
      ORDER BY o.Status
    `);

    const topItemsRequest = connection.request();
    const topItemsWhereClause = buildOrdersFilterQuery(topItemsRequest, req.query, 'o');
    topItemsRequest.input('storeId', sql.Int, req.session.adminUser.storeId);
    const topItemsResult = await topItemsRequest.query(`
      SELECT TOP 10 oi.ItemName, SUM(oi.Quantity) AS SoldQty, SUM(oi.Quantity * oi.UnitPrice) AS Revenue
      FROM dbo.OrderItems oi
      INNER JOIN dbo.Orders o ON oi.OrderId = o.Id
      WHERE ${topItemsWhereClause}
        AND o.StoreId = @storeId
        AND ISNULL(o.IsPaid, 0) = 1
      GROUP BY oi.ItemName
      ORDER BY SUM(oi.Quantity) DESC
    `);

    res.json({
      summary: summaryResult.recordset[0] || {},
      statusBreakdown: statusResult.recordset,
      topItems: topItemsResult.recordset
    });
  } catch (error) {
    if (error.message === 'TRANG_THAI_KHONG_HOP_LE') {
      return res.status(400).json({ message: 'Trạng thái không hợp lệ.' });
    }
    console.error(error);
    res.status(500).json({ message: 'Không lấy được báo cáo.' });
  }
});

app.patch('/api/store/orders/:id/status', requireStore, async (req, res) => {
  const orderId = Number(req.params.id);
  const { status } = req.body;

  if (!Number.isInteger(orderId) || !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Dữ liệu cập nhật trạng thái không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('orderId', sql.Int, orderId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .input('status', sql.NVarChar(30), status)
      .query(`
        UPDATE dbo.Orders
        SET Status = @status
        WHERE Id = @orderId
          AND StoreId = @storeId
          AND ISNULL(IsPaid, 0) = 0
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
    }

    const orderResult = await connection.request()
      .input('orderId', sql.Int, orderId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        SELECT TOP 1 t.QrToken
        FROM dbo.Orders o
        INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
        WHERE o.Id = @orderId
          AND o.StoreId = @storeId
      `);

    emitOrderStatusUpdated({
      orderId,
      status,
      storeId: req.session.adminUser.storeId,
      tableToken: orderResult.recordset[0]?.QrToken || ''
    });

    res.json({ message: 'Cập nhật trạng thái thành công.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Không cập nhật được trạng thái.' });
  }
});

app.patch('/api/store/orders/:id/paid', requireStore, async (req, res) => {
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId)) {
    return res.status(400).json({ message: 'ID đơn hàng không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('orderId', sql.Int, orderId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        UPDATE dbo.Orders
        SET IsPaid = 1,
            PaidAt = SYSUTCDATETIME()
        WHERE Id = @orderId
          AND StoreId = @storeId
          AND Status = 'completed'
          AND ISNULL(IsPaid, 0) = 0
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(400).json({ message: 'Chỉ có thể thanh toán đơn đã hoàn thành và chưa thanh toán.' });
    }

    const orderResult = await connection.request()
      .input('orderId', sql.Int, orderId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        SELECT TOP 1 t.QrToken
        FROM dbo.Orders o
        INNER JOIN dbo.StoreTables t ON o.TableId = t.Id
        WHERE o.Id = @orderId
          AND o.StoreId = @storeId
      `);

    emitOrderPaidForTable({
      orderId,
      storeId: req.session.adminUser.storeId,
      tableToken: orderResult.recordset[0]?.QrToken || '',
      event: 'order-paid'
    });

    return res.json({ message: 'Đã xác nhận thanh toán đơn hàng.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không cập nhật được trạng thái thanh toán.' });
  }
});

app.get('/api/store/menu', requireStore, async (req, res) => {
  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        SELECT Id, Name, Category, Price, IsAvailable
        FROM dbo.MenuItems
        WHERE StoreId = @storeId
        ORDER BY Category, Name
      `);

    return res.json(result.recordset);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được danh sách món.' });
  }
});

app.post('/api/store/menu', requireStore, async (req, res) => {
  const { name, category, price, isAvailable } = req.body;
  const normalizedName = String(name || '').trim();
  const numericPrice = Number(price);

  if (!normalizedName || !['food', 'drink'].includes(category) || Number.isNaN(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ message: 'Dữ liệu món ăn không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    await connection.request()
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .input('name', sql.NVarChar(150), normalizedName)
      .input('category', sql.NVarChar(50), category)
      .input('price', sql.Decimal(18, 2), numericPrice)
      .input('isAvailable', sql.Bit, Boolean(isAvailable))
      .query(`
        INSERT INTO dbo.MenuItems (StoreId, Name, Category, Price, IsAvailable)
        VALUES (@storeId, @name, @category, @price, @isAvailable)
      `);

    res.status(201).json({ message: 'Thêm món thành công.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Không thêm được món.' });
  }
});

app.put('/api/store/menu/:id', requireStore, async (req, res) => {
  const menuId = Number(req.params.id);
  const { name, category, price, isAvailable } = req.body;
  const normalizedName = String(name || '').trim();
  const numericPrice = Number(price);

  if (!Number.isInteger(menuId) || !normalizedName || !['food', 'drink'].includes(category) || Number.isNaN(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ message: 'Dữ liệu cập nhật món ăn không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('menuId', sql.Int, menuId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .input('name', sql.NVarChar(150), normalizedName)
      .input('category', sql.NVarChar(50), category)
      .input('price', sql.Decimal(18, 2), numericPrice)
      .input('isAvailable', sql.Bit, Boolean(isAvailable))
      .query(`
        UPDATE dbo.MenuItems
        SET Name = @name,
            Category = @category,
            Price = @price,
            IsAvailable = @isAvailable
        WHERE Id = @menuId
          AND StoreId = @storeId
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ message: 'Không tìm thấy món ăn.' });
    }

    res.json({ message: 'Cập nhật món thành công.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Không cập nhật được món.' });
  }
});

app.delete('/api/store/menu/:id', requireStore, async (req, res) => {
  const menuId = Number(req.params.id);

  if (!Number.isInteger(menuId)) {
    return res.status(400).json({ message: 'ID món ăn không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('menuId', sql.Int, menuId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query('DELETE FROM dbo.MenuItems WHERE Id = @menuId AND StoreId = @storeId');

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ message: 'Không tìm thấy món ăn.' });
    }

    res.json({ message: 'Xóa món thành công.' });
  } catch (error) {
    if (error.number === 547) {
      return res.status(409).json({ message: 'Món đã có trong đơn, không thể xóa.' });
    }

    console.error(error);
    res.status(500).json({ message: 'Không xóa được món.' });
  }
});

app.get('/api/store/tables', requireStore, async (req, res) => {
  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        SELECT Id, StoreId, TableNumber, QrToken, IsActive, CreatedAt
        FROM dbo.StoreTables
        WHERE StoreId = @storeId
        ORDER BY CreatedAt ASC, Id ASC
      `);

    const mapped = await Promise.all(result.recordset.map((table) => mapTableWithQr(req, table)));
    return res.json(mapped);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được danh sách bàn.' });
  }
});

app.post('/api/store/tables', requireStore, async (req, res) => {
  const { tableNumber, qrToken, quantity, isActive } = req.body;
  const normalizedTable = String(tableNumber || '').trim().toUpperCase();
  const normalizedToken = String(qrToken || `QR-${Date.now()}-${Math.floor(Math.random() * 1000)}`).trim().toUpperCase();
  const hasQuantityInput = quantity !== undefined && quantity !== null && String(quantity).trim() !== '';
  const parsedQuantity = Number(quantity);
  const activeFlag = isActive === undefined ? true : Boolean(isActive);

  if (hasQuantityInput) {
    if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0 || parsedQuantity > 200) {
      return res.status(400).json({ message: 'Số lượng bàn phải là số nguyên từ 1 đến 200.' });
    }

    try {
      const connection = await getPool();
      const storeId = req.session.adminUser.storeId;
      const existingResult = await connection.request()
        .input('storeId', sql.Int, storeId)
        .query(`
          SELECT TableNumber
          FROM dbo.StoreTables
          WHERE StoreId = @storeId
        `);

      const existingNumbers = new Set(
        existingResult.recordset.map((row) => String(row.TableNumber || '').trim().toUpperCase()).filter(Boolean)
      );
      const numericValues = [];
      existingNumbers.forEach((value) => {
        if (/^\d+$/.test(value)) {
          numericValues.push(Number(value));
        }
      });

      let nextNumber = numericValues.length ? Math.max(...numericValues) : existingNumbers.size;
      const transaction = new sql.Transaction(connection);
      await transaction.begin();

      const createdRows = [];
      try {
        for (let i = 0; i < parsedQuantity; i += 1) {
          do {
            nextNumber += 1;
          } while (existingNumbers.has(String(nextNumber)));

          const autoTableNumber = String(nextNumber);
          existingNumbers.add(autoTableNumber);
          const autoQrToken = `QR-${Date.now()}-${Math.floor(Math.random() * 1000000)}-${nextNumber}`;

          const insertResult = await new sql.Request(transaction)
            .input('storeId', sql.Int, storeId)
            .input('tableNumber', sql.NVarChar(40), autoTableNumber)
            .input('qrToken', sql.NVarChar(120), autoQrToken)
            .input('isActive', sql.Bit, activeFlag)
            .query(`
              INSERT INTO dbo.StoreTables (StoreId, TableNumber, QrToken, IsActive)
              OUTPUT INSERTED.Id, INSERTED.StoreId, INSERTED.TableNumber, INSERTED.QrToken, INSERTED.IsActive, INSERTED.CreatedAt
              VALUES (@storeId, @tableNumber, @qrToken, @isActive)
            `);

          createdRows.push(insertResult.recordset[0]);
        }

        await transaction.commit();
      } catch (txError) {
        await transaction.rollback();
        throw txError;
      }

      const mappedTables = await Promise.all(createdRows.map((table) => mapTableWithQr(req, table)));
      const firstTable = mappedTables[0]?.TableNumber;
      const lastTable = mappedTables[mappedTables.length - 1]?.TableNumber;

      return res.status(201).json({
        message: `Đã tạo ${mappedTables.length} bàn mới (${firstTable} - ${lastTable}).`,
        tables: mappedTables
      });
    } catch (error) {
      if (error.number === 2627 || error.number === 2601) {
        return res.status(409).json({ message: 'Số bàn hoặc mã QR đã tồn tại.' });
      }
      console.error(error);
      return res.status(500).json({ message: 'Không tạo được bàn.' });
    }
  }

  if (!normalizedTable) {
    return res.status(400).json({ message: 'Dữ liệu bàn không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const insertResult = await connection.request()
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .input('tableNumber', sql.NVarChar(40), normalizedTable)
      .input('qrToken', sql.NVarChar(120), normalizedToken)
      .input('isActive', sql.Bit, activeFlag)
      .query(`
        INSERT INTO dbo.StoreTables (StoreId, TableNumber, QrToken, IsActive)
        OUTPUT INSERTED.Id, INSERTED.StoreId, INSERTED.TableNumber, INSERTED.QrToken, INSERTED.IsActive, INSERTED.CreatedAt
        VALUES (@storeId, @tableNumber, @qrToken, @isActive)
      `);

    const created = insertResult.recordset[0];
    const withQr = await mapTableWithQr(req, created);
    return res.status(201).json({
      message: 'Tạo bàn thành công.',
      table: withQr
    });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ message: 'Số bàn hoặc mã QR đã tồn tại.' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Không tạo được bàn.' });
  }
});

app.put('/api/store/tables/:id', requireStore, async (req, res) => {
  const tableId = Number(req.params.id);
  const { tableNumber, qrToken, isActive } = req.body;
  const normalizedTable = String(tableNumber || '').trim().toUpperCase();
  const normalizedToken = String(qrToken || '').trim().toUpperCase();

  if (!Number.isInteger(tableId) || !normalizedTable) {
    return res.status(400).json({ message: 'Dữ liệu cập nhật bàn không hợp lệ.' });
  }

  try {
    const connection = await getPool();

    const currentResult = await connection.request()
      .input('tableId', sql.Int, tableId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        SELECT TOP 1 Id, StoreId, TableNumber, QrToken, IsActive, CreatedAt
        FROM dbo.StoreTables
        WHERE Id = @tableId
          AND StoreId = @storeId
      `);

    const currentTable = currentResult.recordset[0];
    if (!currentTable) {
      return res.status(404).json({ message: 'Không tìm thấy bàn.' });
    }

    const nextToken = normalizedToken || currentTable.QrToken;
    const updateResult = await connection.request()
      .input('tableId', sql.Int, tableId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .input('tableNumber', sql.NVarChar(40), normalizedTable)
      .input('qrToken', sql.NVarChar(120), nextToken)
      .input('isActive', sql.Bit, Boolean(isActive))
      .query(`
        UPDATE dbo.StoreTables
        SET TableNumber = @tableNumber,
            QrToken = @qrToken,
            IsActive = @isActive
        WHERE Id = @tableId
          AND StoreId = @storeId
      `);

    if (!updateResult.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy bàn.' });
    }

    const refreshed = await connection.request()
      .input('tableId', sql.Int, tableId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        SELECT TOP 1 Id, StoreId, TableNumber, QrToken, IsActive, CreatedAt
        FROM dbo.StoreTables
        WHERE Id = @tableId
          AND StoreId = @storeId
      `);

    const withQr = await mapTableWithQr(req, refreshed.recordset[0]);
    return res.json({ message: 'Cập nhật bàn thành công.', table: withQr });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ message: 'Số bàn hoặc mã QR đã tồn tại.' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Không cập nhật được bàn.' });
  }
});

app.delete('/api/store/tables/:id', requireStore, async (req, res) => {
  const tableId = Number(req.params.id);
  if (!Number.isInteger(tableId)) {
    return res.status(400).json({ message: 'ID bàn không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('tableId', sql.Int, tableId)
      .input('storeId', sql.Int, req.session.adminUser.storeId)
      .query(`
        DELETE FROM dbo.StoreTables
        WHERE Id = @tableId
          AND StoreId = @storeId
      `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy bàn.' });
    }

    return res.json({ message: 'Xóa bàn thành công.' });
  } catch (error) {
    if (error.number === 547) {
      return res.status(409).json({ message: 'Bàn đã có dữ liệu đơn hàng, không thể xóa.' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Không xóa được bàn.' });
  }
});

app.get('/api/platform/stores', requirePlatform, async (_req, res) => {
  try {
    const connection = await getPool();
    const result = await connection.request().query(`
      SELECT Id, Name, Code, Phone, Address, IsActive, CreatedAt
      FROM dbo.Stores
      ORDER BY CreatedAt DESC
    `);
    return res.json(result.recordset);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được danh sách cửa hàng.' });
  }
});

app.post('/api/platform/stores', requirePlatform, async (req, res) => {
  const { name, phone, code, address, isActive } = req.body;
  const normalizedName = String(name || '').trim();
  const normalizedCode = String(code || buildInternalStoreCode()).trim().toUpperCase();
  const normalizedPhone = String(phone || '').trim();

  if (!normalizedName) {
    return res.status(400).json({ message: 'Tên cửa hàng là bắt buộc.' });
  }

  try {
    const connection = await getPool();
    await connection.request()
      .input('name', sql.NVarChar(160), normalizedName)
      .input('code', sql.NVarChar(60), normalizedCode)
      .input('phone', sql.NVarChar(30), normalizedPhone || null)
      .input('address', sql.NVarChar(250), address || null)
      .input('isActive', sql.Bit, Boolean(isActive))
      .query(`
        INSERT INTO dbo.Stores (Name, Code, Phone, Address, IsActive)
        VALUES (@name, @code, @phone, @address, @isActive)
      `);

    return res.status(201).json({ message: 'Tạo cửa hàng thành công.' });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ message: 'Mã cửa hàng đã tồn tại.' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Không tạo được cửa hàng.' });
  }
});

app.put('/api/platform/stores/:id', requirePlatform, async (req, res) => {
  const storeId = Number(req.params.id);
  const { name, code, phone, address, isActive } = req.body;
  const normalizedName = String(name || '').trim();
  const normalizedCode = String(code || '').trim().toUpperCase();
  const normalizedPhone = String(phone || '').trim();

  if (!Number.isInteger(storeId) || !normalizedName) {
    return res.status(400).json({ message: 'Dữ liệu cửa hàng không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('storeId', sql.Int, storeId)
      .input('name', sql.NVarChar(160), normalizedName)
      .input('code', sql.NVarChar(60), normalizedCode || null)
      .input('phone', sql.NVarChar(30), normalizedPhone || null)
      .input('address', sql.NVarChar(250), address || null)
      .input('isActive', sql.Bit, Boolean(isActive))
      .query(`
        UPDATE dbo.Stores
        SET Name = @name,
            Code = COALESCE(@code, Code),
            Phone = @phone,
            Address = @address,
            IsActive = @isActive
        WHERE Id = @storeId
      `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy cửa hàng.' });
    }

    return res.json({ message: 'Cập nhật cửa hàng thành công.' });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ message: 'Mã cửa hàng đã tồn tại.' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Không cập nhật được cửa hàng.' });
  }
});

app.delete('/api/platform/stores/:id', requirePlatform, async (req, res) => {
  const storeId = Number(req.params.id);
  if (!Number.isInteger(storeId)) {
    return res.status(400).json({ message: 'ID cửa hàng không hợp lệ.' });
  }

  const connection = await getPool();
  const transaction = new sql.Transaction(connection);

  try {
    await transaction.begin();

    const storeCheck = await new sql.Request(transaction)
      .input('storeId', sql.Int, storeId)
      .query('SELECT TOP 1 Id FROM dbo.Stores WHERE Id = @storeId');

    if (!storeCheck.recordset[0]) {
      await transaction.rollback();
      return res.status(404).json({ message: 'Không tìm thấy cửa hàng.' });
    }

    // Delete all users linked to the store first (any role), then clear operational data.
    await new sql.Request(transaction)
      .input('storeId', sql.Int, storeId)
      .query('DELETE FROM dbo.AdminUsers WHERE StoreId = @storeId');

    await new sql.Request(transaction)
      .input('storeId', sql.Int, storeId)
      .query(`
        DELETE oi
        FROM dbo.OrderItems oi
        INNER JOIN dbo.Orders o ON oi.OrderId = o.Id
        WHERE o.StoreId = @storeId
      `);

    await new sql.Request(transaction)
      .input('storeId', sql.Int, storeId)
      .query('DELETE FROM dbo.Orders WHERE StoreId = @storeId');

    await new sql.Request(transaction)
      .input('storeId', sql.Int, storeId)
      .query('DELETE FROM dbo.StoreTables WHERE StoreId = @storeId');

    await new sql.Request(transaction)
      .input('storeId', sql.Int, storeId)
      .query('DELETE FROM dbo.MenuItems WHERE StoreId = @storeId');

    await new sql.Request(transaction)
      .input('storeId', sql.Int, storeId)
      .query('DELETE FROM dbo.Stores WHERE Id = @storeId');

    await transaction.commit();
    return res.json({ message: 'Đã xóa toàn bộ dữ liệu cửa hàng (tài khoản, bàn, menu, đơn hàng).' });
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // ignore rollback errors
    }
    console.error(error);
    return res.status(500).json({ message: 'Không xóa được cửa hàng.' });
  }
});

app.get('/api/platform/stores/:id/tables', requirePlatform, async (req, res) => {
  const storeId = Number(req.params.id);
  if (!Number.isInteger(storeId)) {
    return res.status(400).json({ message: 'ID cửa hàng không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('storeId', sql.Int, storeId)
      .query(`
        SELECT Id, StoreId, TableNumber, QrToken, IsActive, CreatedAt
        FROM dbo.StoreTables
        WHERE StoreId = @storeId
        ORDER BY CreatedAt ASC, Id ASC
      `);

    const mapped = await Promise.all(result.recordset.map((table) => mapTableWithQr(req, table)));
    return res.json(mapped);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được danh sách bàn.' });
  }
});

app.get('/api/platform/store-users', requirePlatform, async (_req, res) => {
  try {
    const connection = await getPool();
    const result = await connection.request().query(`
      SELECT u.Id, u.Username, u.FullName, u.Role, u.StoreId, u.IsActive, s.Name AS StoreName
      FROM dbo.AdminUsers u
      LEFT JOIN dbo.Stores s ON u.StoreId = s.Id
      WHERE u.Role = 'store'
      ORDER BY u.CreatedAt DESC
    `);
    return res.json(result.recordset);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không lấy được danh sách tài khoản cửa hàng.' });
  }
});

app.post('/api/platform/store-users', requirePlatform, async (req, res) => {
  const { username, password, fullName, storeId, isActive } = req.body;
  const normalizedUsername = String(username || '').trim();
  const normalizedName = String(fullName || '').trim();
  const passwordText = String(password || '');
  const normalizedStoreId = Number(storeId);

  if (!normalizedUsername || !normalizedName || passwordText.length < 6 || !Number.isInteger(normalizedStoreId)) {
    return res.status(400).json({ message: 'Dữ liệu tài khoản không hợp lệ.' });
  }

  try {
    const passwordHash = await bcrypt.hash(passwordText, 10);
    const connection = await getPool();
    await connection.request()
      .input('username', sql.NVarChar(60), normalizedUsername)
      .input('passwordHash', sql.NVarChar(255), passwordHash)
      .input('fullName', sql.NVarChar(120), normalizedName)
      .input('storeId', sql.Int, normalizedStoreId)
      .input('isActive', sql.Bit, Boolean(isActive))
      .query(`
        INSERT INTO dbo.AdminUsers (Username, PasswordHash, FullName, Role, StoreId, IsActive)
        VALUES (@username, @passwordHash, @fullName, N'store', @storeId, @isActive)
      `);

    return res.status(201).json({ message: 'Tạo tài khoản cửa hàng thành công.' });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ message: 'Tên đăng nhập đã tồn tại.' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Không tạo được tài khoản cửa hàng.' });
  }
});

app.patch('/api/platform/store-users/:id/status', requirePlatform, async (req, res) => {
  const userId = Number(req.params.id);
  const { isActive } = req.body;
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ message: 'ID tài khoản không hợp lệ.' });
  }

  try {
    const connection = await getPool();
    const result = await connection.request()
      .input('userId', sql.Int, userId)
      .input('isActive', sql.Bit, Boolean(isActive))
      .query(`
        UPDATE dbo.AdminUsers
        SET IsActive = @isActive
        WHERE Id = @userId
          AND Role = 'store'
      `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản cửa hàng.' });
    }

    return res.json({ message: 'Cập nhật trạng thái tài khoản thành công.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không cập nhật được tài khoản.' });
  }
});

app.patch('/api/platform/store-users/:id/password', requirePlatform, async (req, res) => {
  const userId = Number(req.params.id);
  const { password } = req.body;
  const passwordText = String(password || '');

  if (!Number.isInteger(userId) || passwordText.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
  }

  try {
    const passwordHash = await bcrypt.hash(passwordText, 10);
    const connection = await getPool();
    const result = await connection.request()
      .input('userId', sql.Int, userId)
      .input('passwordHash', sql.NVarChar(255), passwordHash)
      .query(`
        UPDATE dbo.AdminUsers
        SET PasswordHash = @passwordHash
        WHERE Id = @userId
          AND Role = 'store'
      `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản cửa hàng.' });
    }

    return res.json({ message: 'Đổi mật khẩu thành công.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Không đổi được mật khẩu.' });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Lỗi hệ thống.' });
});

httpServer.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`[BOOT] Port ${PORT} đã bị chiếm. Vui lòng đổi PORT hoặc dừng tiến trình đang dùng cổng này.`);
    process.exit(1);
  }

  console.error('[BOOT] Không thể khởi động HTTP server:', error);
  process.exit(1);
});

async function bootstrap() {
  const missingEnvVars = getMissingRequiredEnvVars();
  const loadedEnvSummary = loadedEnvFiles.length
    ? loadedEnvFiles.map((envPath) => path.basename(envPath)).join(', ')
    : '(không tìm thấy file .env)';

  console.log(`[BOOT] NODE_ENV=${nodeEnv}; loaded env files: ${loadedEnvSummary}`);

  if (missingEnvVars.length > 0) {
    console.error(`[BOOT] Thiếu biến môi trường bắt buộc: ${missingEnvVars.join(', ')}`);
    process.exit(1);
  }

  try {
    await getPool();
    console.log('[BOOT] Kết nối database thành công.');
  } catch (error) {
    console.error('[BOOT] Không thể kết nối database. Kiểm tra DB_SERVER/DB_PORT/DB_USER/DB_PASSWORD và firewall.', error);
    process.exit(1);
  }

  httpServer.listen(PORT, () => {
    console.log(`Ứng dụng đang chạy tại http://localhost:${PORT}`);
  });
}

bootstrap();
