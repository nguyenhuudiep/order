IF DB_ID(N'OrderFoodDrink') IS NULL
BEGIN
    CREATE DATABASE OrderFoodDrink;
END;
GO

USE OrderFoodDrink;
GO

IF OBJECT_ID(N'dbo.OrderItems', N'U') IS NOT NULL DROP TABLE dbo.OrderItems;
IF OBJECT_ID(N'dbo.Orders', N'U') IS NOT NULL DROP TABLE dbo.Orders;
IF OBJECT_ID(N'dbo.StoreTables', N'U') IS NOT NULL DROP TABLE dbo.StoreTables;
IF OBJECT_ID(N'dbo.DrinkCategories', N'U') IS NOT NULL DROP TABLE dbo.DrinkCategories;
IF OBJECT_ID(N'dbo.MenuItems', N'U') IS NOT NULL DROP TABLE dbo.MenuItems;
IF OBJECT_ID(N'dbo.AdminUsers', N'U') IS NOT NULL DROP TABLE dbo.AdminUsers;
IF OBJECT_ID(N'dbo.Stores', N'U') IS NOT NULL DROP TABLE dbo.Stores;
GO

CREATE TABLE dbo.Stores (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Name NVARCHAR(160) NOT NULL,
    Code NVARCHAR(60) NOT NULL UNIQUE,
    Phone NVARCHAR(30) NULL,
    Address NVARCHAR(250) NULL,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.AdminUsers (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Username NVARCHAR(60) NOT NULL UNIQUE,
    PasswordHash NVARCHAR(255) NOT NULL,
    FullName NVARCHAR(120) NOT NULL,
    Role NVARCHAR(20) NOT NULL CHECK (Role IN (N'platform', N'store')),
    StoreId INT NULL,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_AdminUsers_Stores FOREIGN KEY (StoreId) REFERENCES dbo.Stores(Id)
);

CREATE TABLE dbo.MenuItems (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    StoreId INT NOT NULL,
    Name NVARCHAR(150) NOT NULL,
    Category NVARCHAR(50) NOT NULL CHECK (Category IN (N'food', N'drink')),
    DrinkCategory NVARCHAR(30) NULL,
    Price DECIMAL(18,2) NOT NULL CHECK (Price >= 0),
    IsAvailable BIT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_MenuItems_Stores FOREIGN KEY (StoreId) REFERENCES dbo.Stores(Id)
);

CREATE TABLE dbo.DrinkCategories (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    StoreId INT NOT NULL,
    Code NVARCHAR(30) NOT NULL,
    Name NVARCHAR(120) NOT NULL,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_DrinkCategories_Stores FOREIGN KEY (StoreId) REFERENCES dbo.Stores(Id),
    CONSTRAINT UQ_DrinkCategories_Store_Code UNIQUE (StoreId, Code)
);

CREATE TABLE dbo.StoreTables (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    StoreId INT NOT NULL,
    TableNumber NVARCHAR(40) NOT NULL,
    QrToken NVARCHAR(120) NOT NULL UNIQUE,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_StoreTables_Stores FOREIGN KEY (StoreId) REFERENCES dbo.Stores(Id),
    CONSTRAINT UQ_StoreTable_Number UNIQUE (StoreId, TableNumber)
);

CREATE TABLE dbo.Orders (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    StoreId INT NOT NULL,
    TableId INT NOT NULL,
    CustomerName NVARCHAR(120) NOT NULL,
    CustomerPhone NVARCHAR(30) NULL,
    DeliveryAddress NVARCHAR(250) NULL,
    Note NVARCHAR(500) NULL,
    TotalAmount DECIMAL(18,2) NOT NULL CHECK (TotalAmount >= 0),
    Status NVARCHAR(30) NOT NULL DEFAULT N'pending',
    IsPaid BIT NOT NULL DEFAULT 0,
    PaidAt DATETIME2 NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_Orders_Stores FOREIGN KEY (StoreId) REFERENCES dbo.Stores(Id),
    CONSTRAINT FK_Orders_StoreTables FOREIGN KEY (TableId) REFERENCES dbo.StoreTables(Id)
);

CREATE TABLE dbo.OrderItems (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    OrderId INT NOT NULL,
    MenuItemId INT NOT NULL,
    Quantity INT NOT NULL CHECK (Quantity > 0),
    UnitPrice DECIMAL(18,2) NOT NULL CHECK (UnitPrice >= 0),
    ItemName NVARCHAR(150) NOT NULL,
    CONSTRAINT FK_OrderItems_Orders FOREIGN KEY (OrderId) REFERENCES dbo.Orders(Id) ON DELETE CASCADE,
    CONSTRAINT FK_OrderItems_MenuItems FOREIGN KEY (MenuItemId) REFERENCES dbo.MenuItems(Id)
);
GO

INSERT INTO dbo.Stores (Name, Code, Phone, Address, IsActive)
VALUES (N'Quán Mẫu Trung Tâm', N'QUAN-MAU', N'0909123456', N'123 Đường Mẫu, Quận 1', 1);

DECLARE @StoreId INT = SCOPE_IDENTITY();

INSERT INTO dbo.AdminUsers (Username, PasswordHash, FullName, Role, StoreId, IsActive)
VALUES
(N'superadmin', N'$2b$10$JgHmvoafvBTd0UZ6pGjrbe1XBymXUp2sZ.blGza8l1OhK2PrvEo.2', N'Quản trị hệ thống', N'platform', NULL, 1),
(N'store1', N'$2b$10$XMAlLCTKC0YcA0EqGstt0.mco/EoB8oQ9DVC0zpsWAzCEHQQYM2r6', N'Quản lý cửa hàng mẫu', N'store', @StoreId, 1);

INSERT INTO dbo.StoreTables (StoreId, TableNumber, QrToken, IsActive)
VALUES
(@StoreId, N'B01', N'QR-QUAN-MAU-B01', 1),
(@StoreId, N'B02', N'QR-QUAN-MAU-B02', 1),
(@StoreId, N'B03', N'QR-QUAN-MAU-B03', 1);

INSERT INTO dbo.DrinkCategories (StoreId, Code, Name, IsActive)
VALUES
(@StoreId, N'cafe', N'Cafe', 1),
(@StoreId, N'bubble_tea', N'Trà sữa', 1),
(@StoreId, N'juice', N'Nước ép', 1),
(@StoreId, N'smoothie', N'Sinh tố', 1),
(@StoreId, N'other', N'Đồ uống khác', 1);

INSERT INTO dbo.MenuItems (StoreId, Name, Category, DrinkCategory, Price, IsAvailable)
VALUES
(@StoreId, N'Cơm gà nướng', N'food', NULL, 55000, 1),
(@StoreId, N'Bún bò', N'food', NULL, 50000, 1),
(@StoreId, N'Trà đào', N'drink', N'juice', 30000, 1),
(@StoreId, N'Cà phê sữa', N'drink', N'cafe', 28000, 1);
GO
